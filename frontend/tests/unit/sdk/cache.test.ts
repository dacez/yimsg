import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisplayInfoCache, type DisplayInfoCacheOptions } from '../../../src/sdk/state/cache';
import type { DataGateway, DisplayInfoFetchOptions } from '../../../src/sdk/datagateway/interface';
import type { UserInfo, GroupInfo } from '../../../src/types';

function mockDataGateway(overrides?: Partial<DataGateway>): DataGateway {
  return {
    init: vi.fn().mockResolvedValue({ lastMsgSeq: 0, lastContactSeq: 0 }),
    clear: vi.fn(),
    get_conversations: vi.fn().mockResolvedValue({ offset: 0, total: 0, conversations: [] }),
    get_unread_count: vi.fn().mockResolvedValue(0),
    get_messages: vi.fn().mockResolvedValue([]),
    get_contacts: vi.fn().mockResolvedValue({ offset: 0, total: 0, contacts: [] }),
    get_contact_count: vi.fn().mockResolvedValue(0),
    get_blocklist: vi.fn().mockResolvedValue({ offset: 0, total: 0, users: [] }),
    get_mutelist: vi.fn().mockResolvedValue({ offset: 0, total: 0, mutes: [] }),
    get_user_infos: vi.fn().mockResolvedValue([]),
    get_group_infos: vi.fn().mockResolvedValue([]),
    onMessagesReceived: vi.fn(),
    onContactsChanged: vi.fn(),
    onBlocklistChanged: vi.fn(),
    onMutelistChanged: vi.fn(),
    onUnreadCleared: vi.fn(),
    onConversationDeleted: vi.fn(),
    onMessageDeleted: vi.fn(),
    onSessionKicked: vi.fn(),
    onError: vi.fn(),
    onSync: vi.fn(),
    handleNotification: vi.fn(),
    ...overrides,
  };
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function makeCache(ds: DataGateway | null, options: Partial<DisplayInfoCacheOptions> = {}): DisplayInfoCache {
  return new DisplayInfoCache({
    loadMergeWindowMs: 0,
    dataGateway: () => ds,
    ...options,
  });
}

function getUserInfo(cache: DisplayInfoCache, uid: string) {
  return cache.getUserInfos([uid]).get(uid) || { username: '', nickname: '', avatar: '', remark: '' };
}

function getGroupInfo(cache: DisplayInfoCache, gid: string) {
  return cache.getGroupInfos([gid]).get(gid) || { name: '', avatar: '', remark: '' };
}

describe('DisplayInfoCache', () => {
  let cache: DisplayInfoCache;
  let ds: DataGateway;

  beforeEach(() => {
    ds = mockDataGateway();
    cache = makeCache(ds);
  });

  it('getUserInfo returns empty for unknown uid (miss triggers bg load)', () => {
    const result = getUserInfo(cache, '999');
    expect(result).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
  });

  it('setUserInfos stores and getUserInfo retrieves (hit)', () => {
    cache.setUserInfos([{ uid: '100', nickname: 'Alice', avatar: 'a.png' }]);
    expect(getUserInfo(cache, '100')).toEqual({ username: '', nickname: 'Alice', avatar: 'a.png', remark: '' });
  });

  it('getUserInfo returns empty for zero/empty uid without remote load', () => {
    expect(getUserInfo(cache, '0')).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
    expect(getUserInfo(cache, '')).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
    expect(ds.get_user_infos).not.toHaveBeenCalled();
  });

  it('miss 使用 DataGateway 异步刷新回调更新缓存并通知 UI', async () => {
    (ds.get_user_infos as ReturnType<typeof vi.fn>).mockImplementation(
      async (_uids: string[], options: DisplayInfoFetchOptions<UserInfo>) => {
        expect(typeof options.updateDisplayInfos).toBe('function');
        queueMicrotask(() => options.updateDisplayInfos!([
          { uid: '100', nickname: 'Loaded', avatar: 'f.png', username: '', created_at: 0, updated_at: Date.now() },
        ]));
        return [];
      },
    );

    const updatedKeys: string[][] = [];
    cache.onDisplayUpdated = (keys) => updatedKeys.push(keys);

    expect(getUserInfo(cache, '100')).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
    await flushPromises();

    expect(getUserInfo(cache, '100')).toEqual({ username: '', nickname: 'Loaded', avatar: 'f.png', remark: '' });
    expect(updatedKeys).toEqual([['100']]);
  });

  it('远端资料 updated_at 很旧时，写入后的内存缓存仍按本次刷新时间计算 TTL', async () => {
    (ds.get_user_infos as ReturnType<typeof vi.fn>).mockImplementation(
      async (_uids: string[], options: DisplayInfoFetchOptions<UserInfo>) => {
        queueMicrotask(() => options.updateDisplayInfos?.([
          { uid: '100', nickname: 'Loaded', avatar: 'f.png', username: '', created_at: 0, updated_at: 1 },
        ]));
        return [];
      },
    );

    expect(getUserInfo(cache, '100')).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
    await flushPromises();

    expect(getUserInfo(cache, '100')).toEqual({ username: '', nickname: 'Loaded', avatar: 'f.png', remark: '' });
    await flushPromises();

    expect(ds.get_user_infos).toHaveBeenCalledTimes(1);
  });

  it('stale entry returns old data and triggers background refresh', async () => {
    const shortTtlCache = makeCache(ds, { ttlSeconds: 0.001 });
    shortTtlCache.setUserInfos([{ uid: '100', nickname: 'Old', avatar: 'old.png' }]);
    await new Promise(r => setTimeout(r, 5));
    (ds.get_user_infos as ReturnType<typeof vi.fn>).mockImplementation(
      async (_uids: string[], options: DisplayInfoFetchOptions<UserInfo>) => {
        queueMicrotask(() => options.updateDisplayInfos?.([
          { uid: '100', nickname: 'New', avatar: 'new.png', username: '', created_at: 0, updated_at: Date.now() },
        ]));
        return [];
      },
    );

    const updatedKeys: string[][] = [];
    shortTtlCache.onDisplayUpdated = (keys) => updatedKeys.push(keys);

    expect(getUserInfo(shortTtlCache, '100')).toEqual({ username: '', nickname: 'Old', avatar: 'old.png', remark: '' });
    await flushPromises();

    expect(getUserInfo(shortTtlCache, '100')).toEqual({ username: '', nickname: 'New', avatar: 'new.png', remark: '' });
    expect(updatedKeys).toEqual([['100']]);
  });

  it('deduplicates concurrent loads for same uid', async () => {
    getUserInfo(cache, '100');
    getUserInfo(cache, '100');
    getUserInfo(cache, '100');

    await flushPromises();

    expect(ds.get_user_infos).toHaveBeenCalledTimes(1);
  });

  it('短时间窗口内合并相邻用户资料 key 批次', async () => {
    vi.useFakeTimers();
    try {
      const source = mockDataGateway({
        get_user_infos: vi.fn().mockResolvedValue([]),
      });
      const c = makeCache(source, { loadMergeWindowMs: 8 });

      c.getUserInfos(['100']);
      c.getUserInfos(['200', '300']);
      expect(source.get_user_infos).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(8);
      await Promise.resolve();

      expect(source.get_user_infos).toHaveBeenCalledTimes(1);
      const arg = (source.get_user_infos as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect([...arg].sort()).toEqual(['100', '200', '300']);
      expect((source.get_user_infos as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(
        expect.objectContaining({ cacheTtlMs: expect.any(Number) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('短时间窗口内用户和群分别按协议接口合并', async () => {
    vi.useFakeTimers();
    try {
      const source = mockDataGateway({
        get_user_infos: vi.fn().mockResolvedValue([]),
        get_group_infos: vi.fn().mockResolvedValue([]),
      });
      const c = makeCache(source, { loadMergeWindowMs: 8 });

      c.getUserInfos(['100']);
      c.getGroupInfos(['10']);
      c.getUserInfos(['200']);
      c.getGroupInfos(['20']);

      await vi.advanceTimersByTimeAsync(8);
      await Promise.resolve();

      expect(source.get_user_infos).toHaveBeenCalledTimes(1);
      const userArg = (source.get_user_infos as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect([...userArg].sort()).toEqual(['100', '200']);
      expect(source.get_group_infos).toHaveBeenCalledTimes(1);
      const groupArg = (source.get_group_infos as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect([...groupArg].sort()).toEqual(['10', '20']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('miss without data gateway returns empty, no remote load', () => {
    const c = makeCache(null);
    expect(getUserInfo(c, '100')).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
  });

  it('setGroupInfos stores and getGroupInfo retrieves (hit)', () => {
    cache.setGroupInfos([{ group_id: '10', name: 'Team', avatar: 'g.png' }]);
    expect(getGroupInfo(cache, '10')).toEqual({ name: 'Team', avatar: 'g.png', remark: '' });
  });

  it('group miss triggers background load and calls onDisplayUpdated', async () => {
    (ds.get_group_infos as ReturnType<typeof vi.fn>).mockImplementation(
      async (_groupIds: string[], options: DisplayInfoFetchOptions<GroupInfo>) => {
        queueMicrotask(() => options.updateDisplayInfos?.([
          { group_id: '10', name: 'Loaded', avatar: 'fg.png', owner_uid: '', created_at: 0, updated_at: Date.now() },
        ]));
        return [];
      },
    );

    const updatedKeys: string[][] = [];
    cache.onDisplayUpdated = (keys) => updatedKeys.push(keys);

    expect(getGroupInfo(cache, '10')).toEqual({ name: '', avatar: '', remark: '' });
    await flushPromises();

    expect(getGroupInfo(cache, '10')).toEqual({ name: 'Loaded', avatar: 'fg.png', remark: '' });
    expect(updatedKeys).toEqual([['10']]);
  });

  it('DataGateway 同步返回的群本地数据会与内存结果合并后立即返回并通知', () => {
    (ds.get_group_infos as ReturnType<typeof vi.fn>).mockReturnValue([
      { group_id: '10', name: 'LocalGroup', avatar: 'g.png', owner_uid: '', created_at: 0, updated_at: Date.now() },
    ]);
    const updatedKeys: string[][] = [];
    cache.onDisplayUpdated = (keys, scope) => updatedKeys.push([scope, ...keys]);

    const result = getGroupInfo(cache, '10');

    expect(ds.get_group_infos).toHaveBeenCalledWith(['10'], expect.objectContaining({ cacheTtlMs: expect.any(Number) }));
    expect(result).toEqual({ name: 'LocalGroup', avatar: 'g.png', remark: '' });
    expect(updatedKeys).toEqual([['group', '10']]);
  });

  it('待拉取队列超过上限时抛错', () => {
    const c = makeCache(ds, { queueMaxEntries: 1 });
    c.getUserInfos(['100']);
    expect(() => c.getUserInfos(['200'])).toThrow('显示信息待拉取队列已满');
  });

  it('用户和群待拉取队列上限相互独立（已拆分）', () => {
    // 没有 DataGateway 时不会排空队列，便于观察 pending 是否达到上限。
    const c = makeCache(null, { queueMaxEntries: 1 });
    c.getUserInfos(['100']);
    // 用户队列已满，再塞用户应抛错；群队列独立，不受影响。
    expect(() => c.getUserInfos(['200'])).toThrow('显示信息待拉取队列已满');
    expect(() => c.getGroupInfos(['10'])).not.toThrow();
  });

  it('用户和群缓存条目相互独立（已拆分）', () => {
    const c = makeCache(ds, { maxEntries: 1000 });
    c.setUserInfos([{ uid: '1', nickname: 'A', avatar: '' }]);
    c.setGroupInfos([{ group_id: '10', name: 'G', avatar: '' }]);

    // 拆分后用户写入不会淘汰群条目，反之亦然。
    expect(getUserInfo(c, '1')).toEqual({ username: '', nickname: 'A', avatar: '', remark: '' });
    expect(getGroupInfo(c, '10')).toEqual({ name: 'G', avatar: '', remark: '' });
  });

  it('clear removes all entries', () => {
    cache.setUserInfos([{ uid: '1', nickname: 'A', avatar: '' }]);
    cache.setGroupInfos([{ group_id: '1', name: 'G', avatar: '' }]);
    cache.clear();
    expect(getUserInfo(cache, '1')).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
    expect(getGroupInfo(cache, '1')).toEqual({ name: '', avatar: '', remark: '' });
  });

  it('DataGateway 同步返回的本地数据会与内存结果合并后立即返回并通知', () => {
    (ds.get_user_infos as ReturnType<typeof vi.fn>).mockReturnValue([
      { uid: '100', nickname: 'LocalHit', avatar: 'l.png', username: '', created_at: 0, updated_at: Date.now() },
    ]);
    const updatedKeys: string[][] = [];
    cache.onDisplayUpdated = (keys) => updatedKeys.push(keys);

    const result = getUserInfo(cache, '100');

    expect(ds.get_user_infos).toHaveBeenCalledWith(['100'], expect.objectContaining({ cacheTtlMs: expect.any(Number) }));
    expect(result).toEqual({ username: '', nickname: 'LocalHit', avatar: 'l.png', remark: '' });
    expect(updatedKeys).toEqual([['100']]);
  });

  it('DataGateway 异步返回的本地数据会填充 DisplayInfoCache 并通知', async () => {
    (ds.get_user_infos as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uid: '100', nickname: 'AsyncLocalHit', avatar: 'l.png', username: '', created_at: 0, updated_at: Date.now() },
    ]);
    const updatedKeys: string[][] = [];
    cache.onDisplayUpdated = (keys) => updatedKeys.push(keys);

    expect(getUserInfo(cache, '100')).toEqual({ username: '', nickname: '', avatar: '', remark: '' });
    await flushPromises();

    expect(ds.get_user_infos).toHaveBeenCalledWith(['100'], expect.objectContaining({ cacheTtlMs: expect.any(Number) }));
    expect(getUserInfo(cache, '100')).toEqual({ username: '', nickname: 'AsyncLocalHit', avatar: 'l.png', remark: '' });
    expect(updatedKeys).toEqual([['100']]);
  });

  it('按 batchMaxLimit 串行分批调用 DataGateway', async () => {
    const calls: string[][] = [];
    const source = mockDataGateway({
      get_user_infos: vi.fn(async (uids: string[]) => {
        calls.push([...uids]);
        return [];
      }),
    });
    const c = makeCache(source, { batchMaxLimit: 2 });

    c.getUserInfos(['1', '2', '3', '4', '5']);
    await flushPromises();

    // 后台拉取按 batchMaxLimit=2 拆为 3 批 [2,2,1]；批次内顺序由有界集合的 slot 顺序决定，
    // 与插入顺序无关，故只校验批次大小分布与覆盖到的 id 全集。
    expect(calls.map(c => c.length).sort()).toEqual([1, 2, 2]);
    expect(calls.flat().sort()).toEqual(['1', '2', '3', '4', '5']);
  });

  it('preserves in-memory remark when server response has no remark', async () => {
    const testCache = makeCache(ds, { ttlSeconds: 0 });
    testCache.setUserInfos([{ uid: '100', nickname: 'Alice', avatar: '', remark: 'My Friend' }]);
    (ds.get_user_infos as ReturnType<typeof vi.fn>).mockImplementation(
      async (_uids: string[], options: DisplayInfoFetchOptions<UserInfo>) => {
        queueMicrotask(() => options.updateDisplayInfos?.([
          { uid: '100', username: 'alice', nickname: 'Alice Updated', avatar: 'new.png', remark: '', created_at: 0, updated_at: Date.now() },
        ]));
        return [];
      },
    );

    getUserInfo(testCache, '100');
    await flushPromises();

    const result = getUserInfo(testCache, '100');
    expect(result.nickname).toBe('Alice Updated');
    expect(result.remark).toBe('My Friend');
  });

  it('default TTL 下本地写入更新也保留已有用户备注', () => {
    cache.setUserInfos([{ uid: '100', nickname: 'Alice', avatar: '', remark: 'My Friend' }]);
    cache.setUserInfos([{ uid: '100', nickname: 'Alice Updated', avatar: 'new.png' }]);

    const result = getUserInfo(cache, '100');
    expect(result.nickname).toBe('Alice Updated');
    expect(result.avatar).toBe('new.png');
    expect(result.remark).toBe('My Friend');
  });

  it('preserves group remark when server response has no remark', async () => {
    const testCache = makeCache(ds, { ttlSeconds: 0 });
    testCache.setGroupInfos([{ group_id: '10', name: 'Team', avatar: '', remark: 'My Team' }]);
    (ds.get_group_infos as ReturnType<typeof vi.fn>).mockImplementation(
      async (_groupIds: string[], options: DisplayInfoFetchOptions<GroupInfo>) => {
        queueMicrotask(() => options.updateDisplayInfos?.([
          { group_id: '10', name: 'Team Updated', avatar: 'new.png', remark: '', owner_uid: '', created_at: 0, updated_at: Date.now() },
        ]));
        return [];
      },
    );

    getGroupInfo(testCache, '10');
    await flushPromises();

    const result = getGroupInfo(testCache, '10');
    expect(result.name).toBe('Team Updated');
    expect(result.remark).toBe('My Team');
  });

  it('uid and group misses in the same tick are each loaded exactly once', async () => {
    getUserInfo(cache, '100');
    getGroupInfo(cache, '10');

    await flushPromises();

    expect(ds.get_user_infos).toHaveBeenCalledTimes(1);
    expect(ds.get_group_infos).toHaveBeenCalledTimes(1);
  });

  it('in-flight uid is not re-requested until current load completes', async () => {
    let resolveFirst!: (v: unknown) => void;
    (ds.get_user_infos as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(resolve => { resolveFirst = resolve; }),
    );

    getUserInfo(cache, '100');
    await flushPromises();
    getUserInfo(cache, '100');
    await flushPromises();

    resolveFirst([]);
    await flushPromises();

    expect(ds.get_user_infos).toHaveBeenCalledTimes(1);
  });
});
