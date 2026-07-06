import type { UserInfo, GroupInfo, OrgInfo, TagInfo } from '../../types';
import type { DisplayInfoScope } from '../types';
import type { DataGateway, MaybePromise } from '../datagateway/interface';
import { ValidationError } from '../errors';
import { DEFAULT_CACHE_TTL_SECONDS, DEFAULT_CACHE_MAX_ENTRIES, DEFAULT_PROFILE_LOAD_QUEUE_MAX_ENTRIES, DEFAULT_MAX_BATCH_LIMIT, DISPLAY_CACHE_BUCKET_CAPACITY, DISPLAY_QUEUE_LOAD_FACTOR } from '../internal/sdk-defaults';
import { clampBatchLimit } from '../internal/limits';
import { BoundedU64Map, BoundedU64Set, type BoundedStats } from '../internal/bounded';

const DEFAULT_DISPLAY_INFO_LOAD_MERGE_WINDOW_MS = 8;

type DisplayEntityScope = Extract<DisplayInfoScope, 'user' | 'group' | 'org' | 'tag'>;

type UserDisplayValue = { username: string; nickname: string; avatar: string; remark: string };
type GroupDisplayValue = { name: string; avatar: string; remark: string };
type OrgDisplayValue = { name: string; avatar: string };
type TagDisplayValue = { name: string; avatar: string };

interface DisplayCacheEntry {
  username: string;
  name: string;
  avatar: string;
  remark: string;
  expireAt: number;
}

/** 运行时诊断统计：用户 / 群 / 组织 / tag 四套独立有界集合的状态。 */
export interface DisplayInfoCacheStats {
  readonly user: { readonly cache: BoundedStats; readonly pending: BoundedStats; readonly loading: BoundedStats };
  readonly group: { readonly cache: BoundedStats; readonly pending: BoundedStats; readonly loading: BoundedStats };
  readonly org: { readonly cache: BoundedStats; readonly pending: BoundedStats; readonly loading: BoundedStats };
  readonly tag: { readonly cache: BoundedStats; readonly pending: BoundedStats; readonly loading: BoundedStats };
}

/** SDK 全部长期驻留有界集合的实时运行时统计聚合。 */
export interface BoundedCollectionStats {
  readonly displayInfoCache: DisplayInfoCacheStats;
  readonly pendingRequests: BoundedStats;
}

export interface DisplayInfoCacheOptions {
  ttlSeconds?: number;
  maxEntries?: number;
  queueMaxEntries?: number;
  batchMaxLimit?: number;
  loadMergeWindowMs?: number;
  dataGateway: () => DataGateway | null;
}

/** 仅接受非负十进制 uint64 id（uid / group_id）。其它输入视为无效。 */
function isValidU64Id(key: string): boolean {
  return /^\d+$/.test(key) && key !== '0';
}

/**
 * 单个实体域（user 或 group）的有界缓存状态。
 *
 * 用户和群严格拆分，key 永远是纯 uint64，无需 tagged union / packed key，
 * 也不会发生 uid 与 group_id 冲突，跨语言（C/Rust/Go）实现更简单。
 */
class ScopeStore {
  /** 显示信息缓存：固定容量 FIFO，溢出自动淘汰最旧条目。 */
  readonly cache: BoundedU64Map<DisplayCacheEntry>;
  /** 待拉取去重队列：reject 策略，满则拒绝（上层抛 ValidationError）。 */
  readonly pending: BoundedU64Set;
  /** 在飞（已发起 DataGateway 加载）去重集合。 */
  readonly loading: BoundedU64Set;

  constructor(cacheMaxEntries: number, queueMaxEntries: number) {
    this.cache = new BoundedU64Map<DisplayCacheEntry>({
      capacity: cacheMaxEntries,
      bucketCapacity: DISPLAY_CACHE_BUCKET_CAPACITY,
      eviction: 'fifo',
    });
    this.pending = new BoundedU64Set({
      capacity: queueMaxEntries,
      bucketCapacity: DISPLAY_CACHE_BUCKET_CAPACITY,
      loadFactor: DISPLAY_QUEUE_LOAD_FACTOR,
    });
    this.loading = new BoundedU64Set({
      capacity: queueMaxEntries,
      bucketCapacity: DISPLAY_CACHE_BUCKET_CAPACITY,
      loadFactor: DISPLAY_QUEUE_LOAD_FACTOR,
    });
  }

  hasPending(): boolean { return this.pending.size > 0; }

  /** 当前已排队（待拉取 + 在飞）的 key 数量。 */
  queuedSize(): number { return this.pending.size + this.loading.size; }

  /** 入队待拉取 key；已在飞或已排队则忽略；队列满抛 ValidationError。 */
  enqueue(key: string, maxQueued: number): void {
    if (this.loading.has(key)) return;
    if (this.pending.has(key)) return;
    const queued = this.queuedSize();
    if (queued >= maxQueued || !this.pending.add(key)) {
      throw new ValidationError('显示信息待拉取队列已满', {
        context: 'DisplayInfoCache.enqueue',
        details: { maxQueued, currentSize: queued, attemptedKey: key },
      });
    }
  }

  /** 原子排空待拉取队列并标记为在飞。 */
  drainPending(): string[] {
    const keys = this.pending.drain();
    for (const k of keys) this.loading.add(k);
    return keys;
  }

  doneLoading(keys: string[]): void {
    for (const k of keys) this.loading.delete(k);
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
    this.loading.clear();
  }
}

/**
 * DisplayInfoCache — 用户头像/昵称、群名称的有界 FIFO + TTL 缓存。
 *
 * 用户域与群域完全拆分（userStore / groupStore），各自基于固定容量的
 * BoundedU64Map（缓存）+ BoundedU64Set（待拉取 / 在飞队列），内存静态可估算。
 *
 * - 命中且未过期 → 立即返回
 * - 命中但过期 → 返回旧值并请求 DataGateway 后台刷新
 * - 未命中 → 返回空值，除非 DataGateway 同步返回本地数据
 * - DataGateway 负责后台服务端刷新并回调 updateDisplayInfos
 */
export class DisplayInfoCache {
  private readonly userStore: ScopeStore;
  private readonly groupStore: ScopeStore;
  private readonly orgStore: ScopeStore;
  private readonly tagStore: ScopeStore;
  /** tag_id → org_id 的旁路记录：get_tag_infos 需要 org_id 做路由，供 flush 时取用；容量与待拉取队列同阶，非强一致。 */
  private readonly tagOrgById = new Map<string, string>();
  private cacheTtlMs: number;
  private queueMaxSize: number;
  private batchMaxSize: number;
  private loadMergeWindowMs: number;
  private readonly getDataGateway: () => DataGateway | null;
  private readonly flushTimers: Partial<Record<DisplayEntityScope, ReturnType<typeof setTimeout>>> = {};

  /** Callback fired once per batch when background load updates cache entries. */
  onDisplayUpdated: ((keys: string[], scope: DisplayInfoScope) => void) | null = null;
  onError: ((error: Error, context: string) => void) | null = null;

  constructor(options: DisplayInfoCacheOptions) {
    this.cacheTtlMs = Math.max(0, options.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1000;
    const cacheMaxSize = Math.max(0, options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
    this.queueMaxSize = Math.max(0, options.queueMaxEntries ?? DEFAULT_PROFILE_LOAD_QUEUE_MAX_ENTRIES);
    this.batchMaxSize = clampBatchLimit(options.batchMaxLimit ?? DEFAULT_MAX_BATCH_LIMIT);
    this.loadMergeWindowMs = Math.max(0, options.loadMergeWindowMs ?? DEFAULT_DISPLAY_INFO_LOAD_MERGE_WINDOW_MS);
    this.getDataGateway = options.dataGateway;
    this.userStore = new ScopeStore(cacheMaxSize, this.queueMaxSize);
    this.groupStore = new ScopeStore(cacheMaxSize, this.queueMaxSize);
    this.orgStore = new ScopeStore(cacheMaxSize, this.queueMaxSize);
    this.tagStore = new ScopeStore(cacheMaxSize, this.queueMaxSize);
  }

  private storeOf(scope: DisplayEntityScope): ScopeStore {
    switch (scope) {
      case 'group': return this.groupStore;
      case 'org': return this.orgStore;
      case 'tag': return this.tagStore;
      default: return this.userStore;
    }
  }

  /** 记录 tagId 所属 org_id，供 flush 时批量拉取 get_tag_infos 使用。 */
  private rememberTagOrg(tagId: string, orgId: string): void {
    if (!orgId || orgId === '0') return;
    if (!this.tagOrgById.has(tagId) && this.tagOrgById.size >= this.queueMaxSize) {
      const oldest = this.tagOrgById.keys().next().value;
      if (oldest !== undefined) this.tagOrgById.delete(oldest);
    }
    this.tagOrgById.set(tagId, orgId);
  }

  /** 取一批待拉取 tagId 里任意一个已知的 org_id（同批通常同属一个组织）。 */
  private orgForTags(tagIds: string[]): string {
    for (const id of tagIds) {
      const orgId = this.tagOrgById.get(id);
      if (orgId) return orgId;
    }
    return '0';
  }

  getUserInfos(uids: string[]): Map<string, UserDisplayValue> {
    const result = new Map<string, UserDisplayValue>();
    const now = Date.now();
    for (const raw of uids) {
      const key = String(raw);
      if (!isValidU64Id(key)) {
        result.set(key, this.emptyUserValue());
        continue;
      }
      const entry = this.userStore.cache.get(key);
      if (entry) {
        result.set(key, this.toUserValue(entry));
        if (entry.expireAt <= now) this.userStore.enqueue(key, this.queueMaxSize);
      } else {
        result.set(key, this.emptyUserValue());
        this.userStore.enqueue(key, this.queueMaxSize);
      }
    }
    this.scheduleFlushScope('user');
    this.mergeCachedUserValues(uids, result);
    return result;
  }

  getGroupInfos(groupIds: string[]): Map<string, GroupDisplayValue> {
    const result = new Map<string, GroupDisplayValue>();
    const now = Date.now();
    for (const raw of groupIds) {
      const key = String(raw);
      if (!isValidU64Id(key)) {
        result.set(key, this.emptyGroupValue());
        continue;
      }
      const entry = this.groupStore.cache.get(key);
      if (entry) {
        result.set(key, this.toGroupValue(entry));
        if (entry.expireAt <= now) this.groupStore.enqueue(key, this.queueMaxSize);
      } else {
        result.set(key, this.emptyGroupValue());
        this.groupStore.enqueue(key, this.queueMaxSize);
      }
    }
    this.scheduleFlushScope('group');
    this.mergeCachedGroupValues(groupIds, result);
    return result;
  }

  getOrgInfos(orgIds: string[]): Map<string, OrgDisplayValue> {
    const result = new Map<string, OrgDisplayValue>();
    const now = Date.now();
    for (const raw of orgIds) {
      const key = String(raw);
      if (!isValidU64Id(key)) {
        result.set(key, this.emptyOrgValue());
        continue;
      }
      const entry = this.orgStore.cache.get(key);
      if (entry) {
        result.set(key, this.toOrgValue(entry));
        if (entry.expireAt <= now) this.orgStore.enqueue(key, this.queueMaxSize);
      } else {
        result.set(key, this.emptyOrgValue());
        this.orgStore.enqueue(key, this.queueMaxSize);
      }
    }
    this.scheduleFlushScope('org');
    this.mergeCachedOrgValues(orgIds, result);
    return result;
  }

  getTagInfos(orgId: string, tagIds: string[]): Map<string, TagDisplayValue> {
    const result = new Map<string, TagDisplayValue>();
    const now = Date.now();
    const org = String(orgId || '0');
    for (const raw of tagIds) {
      const key = String(raw);
      if (!isValidU64Id(key)) {
        result.set(key, this.emptyTagValue());
        continue;
      }
      this.rememberTagOrg(key, org);
      const entry = this.tagStore.cache.get(key);
      if (entry) {
        result.set(key, this.toTagValue(entry));
        if (entry.expireAt <= now) this.tagStore.enqueue(key, this.queueMaxSize);
      } else {
        result.set(key, this.emptyTagValue());
        this.tagStore.enqueue(key, this.queueMaxSize);
      }
    }
    this.scheduleFlushScope('tag');
    this.mergeCachedTagValues(tagIds, result);
    return result;
  }

  // ---- Write-through (used by client.ts mutations) ----

  setUserInfos(entries: Array<{ uid: string; username?: string; nickname: string; avatar: string; remark?: string }>): void {
    this.upsertUserInfos(entries.map(e => ({
      uid: String(e.uid),
      username: e.username || '',
      nickname: e.nickname,
      avatar: e.avatar,
      remark: e.remark,
      __force_remark: Object.prototype.hasOwnProperty.call(e, 'remark'),
      created_at: 0,
      updated_at: Date.now(),
    } as UserInfo & { __force_remark: boolean })));
  }

  setGroupInfos(entries: Array<{ group_id: string; name: string; avatar: string; remark?: string }>): void {
    this.upsertGroupInfos(entries.map(e => ({
      group_id: String(e.group_id),
      name: e.name,
      avatar: e.avatar,
      owner_uid: '',
      remark: e.remark,
      __force_remark: Object.prototype.hasOwnProperty.call(e, 'remark'),
      created_at: 0,
      updated_at: Date.now(),
    } as GroupInfo & { __force_remark: boolean })));
  }

  // ---- Lifecycle / diagnostics ----

  clear(): void {
    this.clearFlushTimers();
    this.userStore.clear();
    this.groupStore.clear();
    this.orgStore.clear();
    this.tagStore.clear();
    this.tagOrgById.clear();
  }

  /** 暴露用户 / 群 / 组织 / tag 四套有界集合的运行时统计，用于 benchmark / debug。 */
  stats(): DisplayInfoCacheStats {
    return {
      user: {
        cache: this.userStore.cache.stats(),
        pending: this.userStore.pending.stats(),
        loading: this.userStore.loading.stats(),
      },
      group: {
        cache: this.groupStore.cache.stats(),
        pending: this.groupStore.pending.stats(),
        loading: this.groupStore.loading.stats(),
      },
      org: {
        cache: this.orgStore.cache.stats(),
        pending: this.orgStore.pending.stats(),
        loading: this.orgStore.loading.stats(),
      },
      tag: {
        cache: this.tagStore.cache.stats(),
        pending: this.tagStore.pending.stats(),
        loading: this.tagStore.loading.stats(),
      },
    };
  }

  // ---- Private: DataGateway loading ----

  private scheduleFlushScope(scope: DisplayEntityScope): void {
    if (!this.storeOf(scope).hasPending()) return;
    if (!this.getDataGateway()) return;
    if (this.loadMergeWindowMs === 0) {
      this.flushScope(scope);
      return;
    }
    if (this.flushTimers[scope]) return;
    this.flushTimers[scope] = setTimeout(() => {
      this.flushTimers[scope] = undefined;
      this.flushScope(scope);
    }, this.loadMergeWindowMs);
  }

  private flushScope(scope: DisplayEntityScope): void {
    const ds = this.getDataGateway();
    if (!ds) return;

    const store = this.storeOf(scope);
    if (!store.hasPending()) return;

    const pending = store.drainPending();
    if (pending.length === 0) return;

    if (scope === 'user') {
      this.batchLoad(pending, ds, {
        scope: 'user',
        load: (ids) => ds.get_user_infos(ids, {
          cacheTtlMs: this.cacheTtlMs,
          updateDisplayInfos: items => {
            if (this.getDataGateway() !== ds) return;
            const updated = this.upsertUserInfos(items);
            if (updated.length > 0) this.onDisplayUpdated?.(updated, 'user');
          },
        }),
        getId: p => String(p.uid),
        getUpdatedAt: p => p.updated_at,
        getRemark: p => p.remark || '',
        toEntry: (p, remark, expireAt): DisplayCacheEntry => ({
          username: p.username || '', name: p.nickname || '',
          avatar: p.avatar || '', remark, expireAt,
        }),
      });
      return;
    }

    if (scope === 'group') {
      this.batchLoad(pending, ds, {
        scope: 'group',
        load: (ids) => ds.get_group_infos(ids, {
          cacheTtlMs: this.cacheTtlMs,
          updateDisplayInfos: items => {
            if (this.getDataGateway() !== ds) return;
            const updated = this.upsertGroupInfos(items);
            if (updated.length > 0) this.onDisplayUpdated?.(updated, 'group');
          },
        }),
        getId: g => String(g.group_id),
        getUpdatedAt: g => g.updated_at,
        getRemark: g => g.remark || '',
        toEntry: (g, remark, expireAt): DisplayCacheEntry => ({
          username: '', name: g.name || '', avatar: g.avatar || '', remark, expireAt,
        }),
      });
      return;
    }

    if (scope === 'org') {
      this.batchLoad(pending, ds, {
        scope: 'org',
        load: (ids) => ds.get_org_infos(ids, {
          cacheTtlMs: this.cacheTtlMs,
          updateDisplayInfos: items => {
            if (this.getDataGateway() !== ds) return;
            const updated = this.upsertOrgInfos(items);
            if (updated.length > 0) this.onDisplayUpdated?.(updated, 'org');
          },
        }),
        getId: o => String(o.org_id),
        // OrgInfo 是无 seq/updated_at 的字典条目，过期基准用本地接收时刻（batchLoad 内的 now 兜底）。
        getUpdatedAt: () => 0,
        getRemark: () => '',
        toEntry: (o, remark, expireAt): DisplayCacheEntry => ({
          username: '', name: o.name || '', avatar: o.avatar || '', remark, expireAt,
        }),
      });
      return;
    }

    // scope === 'tag'
    this.batchLoad(pending, ds, {
      scope: 'tag',
      load: (ids) => ds.get_tag_infos(this.orgForTags(ids), ids, {
        cacheTtlMs: this.cacheTtlMs,
        updateDisplayInfos: items => {
          if (this.getDataGateway() !== ds) return;
          const updated = this.upsertTagInfos(items);
          if (updated.length > 0) this.onDisplayUpdated?.(updated, 'tag');
        },
      }),
      getId: t => String(t.tag_id),
      // TagInfo 同样是无 seq/updated_at 的字典条目。
      getUpdatedAt: () => 0,
      getRemark: () => '',
      toEntry: (t, remark, expireAt): DisplayCacheEntry => ({
        username: '', name: t.name || '', avatar: t.avatar || '', remark, expireAt,
      }),
    });
  }

  private batchLoad<TRemote>(
    keys: string[],
    ds: DataGateway,
    strategy: {
      scope: DisplayEntityScope;
      load: (ids: string[]) => MaybePromise<TRemote[]>;
      getId: (item: TRemote) => string;
      getUpdatedAt: (item: TRemote) => number;
      getRemark: (item: TRemote) => string;
      toEntry: (item: TRemote, remark: string, expireAt: number) => DisplayCacheEntry;
    },
  ): void {
    const batches = this.splitBatches(keys);
    let chain: Promise<void> | null = null;
    const loadedKeys = new Set<string>();

    const runBatch = (batch: string[]): void | Promise<void> => {
      try {
        const loaded = strategy.load(batch);
        if (!this.isPromiseLike(loaded)) {
          const updated = this.applyLoadedItems(loaded, ds, strategy);
          for (const id of updated) loadedKeys.add(id);
          if (updated.length > 0) this.onDisplayUpdated?.(updated, strategy.scope);
          return;
        }

        return loaded
          .then(items => {
            const updated = this.applyLoadedItems(items, ds, strategy);
            for (const id of updated) loadedKeys.add(id);
            if (updated.length > 0) this.onDisplayUpdated?.(updated, strategy.scope);
          })
          .catch(e => {
            if (!this.shouldIgnoreLoadError(e)) this.reportError(e, 'batchLoad failed');
          });
      } catch (e) {
        if (!this.shouldIgnoreLoadError(e)) this.reportError(e, 'batchLoad failed');
      }
    };

    for (const batch of batches) {
      if (chain) {
        chain = chain.then(() => Promise.resolve(runBatch(batch)));
        continue;
      }
      const first = runBatch(batch);
      if (this.isPromiseLike(first)) chain = first;
    }

    const store = this.storeOf(strategy.scope);
    if (chain) {
      chain.finally(() => store.doneLoading([...loadedKeys, ...keys]));
    } else {
      store.doneLoading(keys);
    }
  }

  private applyLoadedItems<TRemote>(
    items: TRemote[],
    ds: DataGateway,
    strategy: {
      scope: DisplayEntityScope;
      getId: (item: TRemote) => string;
      getUpdatedAt: (item: TRemote) => number;
      getRemark: (item: TRemote) => string;
      toEntry: (item: TRemote, remark: string, expireAt: number) => DisplayCacheEntry;
    },
  ): string[] {
    if (this.getDataGateway() !== ds) return [];
    const cache = this.storeOf(strategy.scope).cache;
    const updatedKeys: string[] = [];
    const now = Date.now();
    for (const item of items) {
      const id = strategy.getId(item);
      if (!isValidU64Id(id)) continue;
      // Preserve in-memory remark if present (may be ahead of local store)
      const remark = cache.get(id)?.remark || strategy.getRemark(item);
      const expireAt = (strategy.getUpdatedAt(item) || now) + this.cacheTtlMs;
      cache.set(id, strategy.toEntry(item, remark, expireAt));
      updatedKeys.push(id);
    }
    return updatedKeys;
  }

  private mergeCachedUserValues(uids: string[], result: Map<string, UserDisplayValue>): void {
    const now = Date.now();
    for (const raw of uids) {
      const key = String(raw);
      if (!isValidU64Id(key)) continue;
      const entry = this.userStore.cache.get(key);
      if (entry && entry.expireAt > now) result.set(key, this.toUserValue(entry));
    }
  }

  private mergeCachedGroupValues(groupIds: string[], result: Map<string, GroupDisplayValue>): void {
    const now = Date.now();
    for (const raw of groupIds) {
      const key = String(raw);
      if (!isValidU64Id(key)) continue;
      const entry = this.groupStore.cache.get(key);
      if (entry && entry.expireAt > now) result.set(key, this.toGroupValue(entry));
    }
  }

  private mergeCachedOrgValues(orgIds: string[], result: Map<string, OrgDisplayValue>): void {
    const now = Date.now();
    for (const raw of orgIds) {
      const key = String(raw);
      if (!isValidU64Id(key)) continue;
      const entry = this.orgStore.cache.get(key);
      if (entry && entry.expireAt > now) result.set(key, this.toOrgValue(entry));
    }
  }

  private mergeCachedTagValues(tagIds: string[], result: Map<string, TagDisplayValue>): void {
    const now = Date.now();
    for (const raw of tagIds) {
      const key = String(raw);
      if (!isValidU64Id(key)) continue;
      const entry = this.tagStore.cache.get(key);
      if (entry && entry.expireAt > now) result.set(key, this.toTagValue(entry));
    }
  }

  private splitBatches(ids: string[]): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += this.batchMaxSize) {
      batches.push(ids.slice(i, i + this.batchMaxSize));
    }
    return batches;
  }

  private clearFlushTimers(): void {
    for (const scope of ['user', 'group', 'org', 'tag'] as const) {
      const timer = this.flushTimers[scope];
      if (timer) clearTimeout(timer);
      this.flushTimers[scope] = undefined;
    }
  }

  private isPromiseLike<T>(value: MaybePromise<T> | void): value is Promise<T> {
    return Boolean(value && typeof (value as Promise<T>).then === 'function');
  }

  private upsertUserInfos(items: UserInfo[]): string[] {
    const cache = this.userStore.cache;
    const updatedKeys: string[] = [];
    const now = Date.now();
    for (const item of items) {
      const id = String(item.uid || '0');
      if (!isValidU64Id(id)) continue;
      const existingRemark = cache.get(id)?.remark;
      const forceRemark = Boolean((item as UserInfo & { __force_remark?: boolean }).__force_remark);
      const remark = forceRemark ? item.remark || '' : item.remark || existingRemark || '';
      cache.set(id, {
        username: item.username || '',
        name: item.nickname || '',
        avatar: item.avatar || '',
        remark,
        expireAt: now + this.cacheTtlMs,
      });
      updatedKeys.push(id);
    }
    return updatedKeys;
  }

  private upsertGroupInfos(items: GroupInfo[]): string[] {
    const cache = this.groupStore.cache;
    const updatedKeys: string[] = [];
    const now = Date.now();
    for (const item of items) {
      const id = String(item.group_id || '0');
      if (!isValidU64Id(id)) continue;
      const existingRemark = cache.get(id)?.remark;
      const forceRemark = Boolean((item as GroupInfo & { __force_remark?: boolean }).__force_remark);
      const remark = forceRemark ? item.remark || '' : item.remark || existingRemark || '';
      cache.set(id, {
        username: '',
        name: item.name || '',
        avatar: item.avatar || '',
        remark,
        expireAt: now + this.cacheTtlMs,
      });
      updatedKeys.push(id);
    }
    return updatedKeys;
  }

  private upsertOrgInfos(items: OrgInfo[]): string[] {
    const cache = this.orgStore.cache;
    const updatedKeys: string[] = [];
    const now = Date.now();
    for (const item of items) {
      const id = String(item.org_id || '0');
      if (!isValidU64Id(id)) continue;
      cache.set(id, {
        username: '',
        name: item.name || '',
        avatar: item.avatar || '',
        remark: '',
        expireAt: now + this.cacheTtlMs,
      });
      updatedKeys.push(id);
    }
    return updatedKeys;
  }

  private upsertTagInfos(items: TagInfo[]): string[] {
    const cache = this.tagStore.cache;
    const updatedKeys: string[] = [];
    const now = Date.now();
    for (const item of items) {
      const id = String(item.tag_id || '0');
      if (!isValidU64Id(id)) continue;
      cache.set(id, {
        username: '',
        name: item.name || '',
        avatar: item.avatar || '',
        remark: '',
        expireAt: now + this.cacheTtlMs,
      });
      updatedKeys.push(id);
    }
    return updatedKeys;
  }

  private toUserValue(entry: DisplayCacheEntry): UserDisplayValue {
    return { username: entry.username, nickname: entry.name, avatar: entry.avatar, remark: entry.remark };
  }

  private toGroupValue(entry: DisplayCacheEntry): GroupDisplayValue {
    return { name: entry.name, avatar: entry.avatar, remark: entry.remark };
  }

  private toOrgValue(entry: DisplayCacheEntry): OrgDisplayValue {
    return { name: entry.name, avatar: entry.avatar };
  }

  private toTagValue(entry: DisplayCacheEntry): TagDisplayValue {
    return { name: entry.name, avatar: entry.avatar };
  }

  private emptyUserValue(): UserDisplayValue {
    return { username: '', nickname: '', avatar: '', remark: '' };
  }

  private emptyGroupValue(): GroupDisplayValue {
    return { name: '', avatar: '', remark: '' };
  }

  private emptyOrgValue(): OrgDisplayValue {
    return { name: '', avatar: '' };
  }

  private emptyTagValue(): TagDisplayValue {
    return { name: '', avatar: '' };
  }

  private shouldIgnoreLoadError(error: unknown): boolean {
    if (!this.getDataGateway()) return true;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message === 'disconnected' || message === 'connection closed' || message === 'not connected';
  }

  private reportError(error: unknown, context: string): void {
    const normalized = error instanceof Error ? error : new Error(String(error ?? 'unknown error'));
    this.onError?.(normalized, context);
  }
}
