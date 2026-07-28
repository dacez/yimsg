import {
  SelectionStore,
  createBoundedList,
  invalidateAllBoundedLists,
  localPageSource,
  registeredBoundedListIds,
  serverPageSource,
  type BoundedList,
  type BoundedListOptions,
  type BoundedListState,
  type Direction,
  type ErrorPhase,
  type FetchPageRequest,
  type PageLoadResult,
  type SelectionSnapshot,
} from '../../../../../packages/uikit/src/app/bounded-list/index.ts';

interface TestItem {
  readonly id: string;
  readonly label: string;
  readonly order: number;
}

interface TestQuery {
  readonly keyword: string;
}

type TextKey =
  | 'loading'
  | 'empty'
  | 'emptyFiltered'
  | 'headBoundary'
  | 'tailBoundary'
  | 'updatePill'
  | 'error'
  | 'retry';

interface MountConfig {
  readonly id?: string;
  readonly itemCount?: number;
  readonly logicalCount?: number;
  readonly items?: readonly TestItem[];
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly initialStart?: number;
  readonly initialQuery?: TestQuery;
  readonly sourceKind?: 'server' | 'local';
  readonly freshEdge?: 'head' | 'tail';
  readonly stickyPx?: number;
  readonly reachPx?: number;
  readonly settleFrames?: number;
  readonly active?: boolean;
  readonly separateContent?: boolean;
  readonly detachedScroller?: boolean;
  readonly pillHost?: 'default' | 'explicit' | 'false';
  readonly normalize?: 'none' | 'reverse' | 'dedupe-sort';
  readonly renderParts?: number;
  readonly rowHeight?: number;
  readonly pinnedItems?: readonly TestItem[];
  readonly selection?: {
    readonly mode: 'single' | 'multi';
    readonly max?: number;
    readonly storeKey?: string;
    readonly storeMax?: number;
  };
  readonly text?: Partial<Record<TextKey, string | false>>;
  readonly fetchByIdentity?: boolean;
  readonly fetchDelayMs?: number;
  readonly overflowPageBy?: number;
  readonly register?: 'global' | 'custom';
  readonly onLoadProgress?: boolean;
  readonly progressValues?: readonly number[];
  readonly progressByKeyword?: Readonly<Record<string, readonly number[]>>;
  readonly initialA11y?: {
    readonly tabindex?: string;
    readonly role?: string;
    readonly ariaMultiselectable?: string;
  };
  readonly autoReset?: boolean;
  readonly callbacks?: boolean;
}

interface FetchCall {
  readonly cursor?: string;
  readonly backward: boolean;
  readonly limit: number;
  readonly query: TestQuery;
  readonly phase: ErrorPhase;
  readonly hasOnProgress?: boolean;
}

interface HarnessEvent {
  readonly type: string;
  readonly payload: unknown;
}

interface DeferredGate {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(reason: Error): void;
}

interface HarnessEntry {
  readonly key: string;
  readonly config: Required<
    Pick<
      MountConfig,
      | 'id'
      | 'pageSize'
      | 'maxPages'
      | 'initialStart'
      | 'sourceKind'
      | 'freshEdge'
      | 'active'
      | 'separateContent'
      | 'detachedScroller'
      | 'pillHost'
      | 'normalize'
      | 'renderParts'
      | 'rowHeight'
      | 'fetchByIdentity'
      | 'fetchDelayMs'
      | 'overflowPageBy'
      | 'register'
      | 'onLoadProgress'
      | 'callbacks'
    >
  > &
    MountConfig;
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  readonly content: HTMLElement;
  readonly explicitPillHost: HTMLElement;
  readonly list: BoundedList<TestItem, TestQuery>;
  readonly fetchCalls: FetchCall[];
  readonly events: HarnessEvent[];
  readonly failNext: Set<ErrorPhase>;
  items: TestItem[];
  logicalCount: number;
  active: boolean;
  pinnedItems: TestItem[];
  pauseNextPage: boolean;
  pauseNextIdentity: boolean;
  pageGate?: DeferredGate;
  identityGate?: DeferredGate;
  running: Set<Promise<unknown>>;
}

const entries = new Map<string, HarnessEntry>();
const sharedStores = new Map<string, SelectionStore>();
const customRegistry = new Map<
  string,
  { readonly id: string; invalidate(): void | Promise<void> }
>();
let sequence = 0;

function createItems(count: number, prefix = 'item', start = 0): TestItem[] {
  return Array.from({ length: count }, (_, index) => {
    const order = start + index;
    return {
      id: String(order),
      label: `${prefix}-${order}`,
      order,
    };
  });
}

function createDeferredGate(): DeferredGate {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cloneQuery(query: TestQuery): TestQuery {
  return { keyword: query?.keyword ?? '' };
}

function cloneItem(item: TestItem): TestItem {
  return { id: item.id, label: item.label, order: item.order };
}

function phaseOf(req: FetchPageRequest<TestQuery>): ErrorPhase {
  if (req.cursor === undefined) return 'reset';
  return req.backward ? 'backward' : 'forward';
}

function generatedItem(index: number): TestItem {
  return {
    id: String(index),
    label: `item-${index}`,
    order: index,
  };
}

function currentItems(entry: HarnessEntry, query: TestQuery): TestItem[] {
  const keyword = query?.keyword ?? '';
  if (entry.logicalCount > 0) {
    if (!keyword) return [];
    const exact = Number(keyword);
    if (Number.isSafeInteger(exact) && exact >= 0 && exact < entry.logicalCount) {
      return [generatedItem(exact)];
    }
    return [];
  }
  const source = entry.items.map(cloneItem);
  return keyword ? source.filter((item) => item.label.includes(keyword)) : source;
}

function pageFromRange(
  entry: HarnessEntry,
  req: FetchPageRequest<TestQuery>,
): PageLoadResult<TestItem> {
  const fullItems = currentItems(entry, req.query);
  const total = entry.logicalCount > 0 && !req.query?.keyword
    ? entry.logicalCount
    : fullItems.length;
  const limit = Math.max(0, req.limit + entry.config.overflowPageBy);
  const cursor = req.cursor === undefined
    ? entry.config.initialStart
    : Number(req.cursor);
  const safeCursor = Number.isFinite(cursor) ? cursor : 0;
  const start = req.backward
    ? Math.max(0, safeCursor - limit)
    : Math.max(0, safeCursor);
  const end = Math.min(total, req.backward ? safeCursor : start + limit);
  const items: TestItem[] = [];
  for (let index = start; index < end; index++) {
    items.push(entry.logicalCount > 0 ? generatedItem(index) : cloneItem(fullItems[index]));
  }
  return {
    items,
    startCursor: String(start),
    endCursor: String(end),
    hasMoreBackward: start > 0,
    hasMoreForward: end < total,
    total,
  };
}

async function waitForGate(entry: HarnessEntry, kind: 'page' | 'identity'): Promise<void> {
  if (kind === 'page' && entry.pauseNextPage) {
    entry.pauseNextPage = false;
    entry.pageGate = createDeferredGate();
    await entry.pageGate.promise;
    entry.pageGate = undefined;
  }
  if (kind === 'identity' && entry.pauseNextIdentity) {
    entry.pauseNextIdentity = false;
    entry.identityGate = createDeferredGate();
    await entry.identityGate.promise;
    entry.identityGate = undefined;
  }
}

function recordPromise(entry: HarnessEntry, promise: Promise<unknown>): void {
  entry.running.add(promise);
  void promise.finally(() => entry.running.delete(promise));
}

function normalizeFor(config: MountConfig): ((items: readonly TestItem[]) => TestItem[]) | undefined {
  if (config.normalize === 'reverse') {
    return (items) => [...items].reverse();
  }
  if (config.normalize === 'dedupe-sort') {
    return (items) => {
      const byId = new Map<string, TestItem>();
      for (const item of items) byId.set(item.id, item);
      return [...byId.values()].sort((a, b) => a.order - b.order);
    };
  }
  return undefined;
}

function textFor(config: MountConfig): BoundedListOptions<TestItem, TestQuery>['text'] {
  const defaults: Record<TextKey, string> = {
    loading: '正在加载',
    empty: '列表为空',
    emptyFiltered: '没有匹配项',
    headBoundary: '已到开头',
    tailBoundary: '已到结尾',
    updatePill: '有 {count} 条更新',
    error: '加载失败：{message}',
    retry: '重新加载',
  };
  const value = (key: TextKey): string | false =>
    config.text && Object.prototype.hasOwnProperty.call(config.text, key)
      ? config.text[key] ?? false
      : defaults[key];
  const loading = value('loading');
  const empty = value('empty');
  const emptyFiltered = value('emptyFiltered');
  const headBoundary = value('headBoundary');
  const tailBoundary = value('tailBoundary');
  const updatePill = value('updatePill');
  const error = value('error');
  const retry = value('retry');
  return {
    ...(loading === false ? {} : { loading: () => loading }),
    ...(empty === false ? {} : { empty: () => empty }),
    ...(emptyFiltered === false ? {} : { emptyFiltered: () => emptyFiltered }),
    ...(headBoundary === false ? {} : { headBoundary: () => headBoundary }),
    ...(tailBoundary === false ? {} : { tailBoundary: () => tailBoundary }),
    ...(updatePill === false
      ? {}
      : { updatePill: (count: number) => updatePill.replace('{count}', String(count)) }),
    ...(error === false
      ? {}
      : {
        error: (reason: unknown) => error.replace(
          '{message}',
          reason instanceof Error ? reason.message : String(reason),
        ),
      }),
    ...(retry === false ? {} : { retry: () => retry }),
  };
}

function recordFetchCall(
  fetchCalls: FetchCall[],
  req: FetchPageRequest<TestQuery>,
  phase: ErrorPhase,
): void {
  fetchCalls.push({
    ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
    backward: req.backward,
    limit: req.limit,
    query: cloneQuery(req.query),
    phase,
    ...(req.onProgress ? { hasOnProgress: true } : {}),
  });
}

function eventPayload(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof Event) return { type: value.type };
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(eventPayload);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) result[key] = eventPayload(nested);
    return result;
  }
  return value;
}

function pushEvent(entry: Pick<HarnessEntry, 'events'>, type: string, payload: unknown): void {
  entry.events.push({ type, payload: eventPayload(payload) });
}

function createHost(config: MountConfig, key: string): {
  root: HTMLElement;
  scroller: HTMLElement;
  content: HTMLElement;
  explicitPillHost: HTMLElement;
} {
  const root = document.createElement('section');
  root.className = 'bl-case';
  root.dataset.case = key;

  const explicitPillHost = document.createElement('div');
  explicitPillHost.className = 'bl-explicit-pill-host';
  root.appendChild(explicitPillHost);

  const scroller = document.createElement('div');
  scroller.className = 'bl-scroller';
  scroller.setAttribute('aria-label', `BoundedList ${key}`);
  if (config.initialA11y?.tabindex !== undefined) {
    scroller.setAttribute('tabindex', config.initialA11y.tabindex);
  }
  if (config.initialA11y?.role !== undefined) {
    scroller.setAttribute('role', config.initialA11y.role);
  }
  if (config.initialA11y?.ariaMultiselectable !== undefined) {
    scroller.setAttribute('aria-multiselectable', config.initialA11y.ariaMultiselectable);
  }

  const content = config.separateContent ? document.createElement('div') : scroller;
  if (config.separateContent) {
    content.className = 'bl-content';
    scroller.appendChild(content);
  }

  if (!config.detachedScroller) root.appendChild(scroller);
  document.querySelector('#fixtures')!.appendChild(root);
  return { root, scroller, content, explicitPillHost };
}

async function mount(configInput: MountConfig = {}): Promise<string> {
  const key = `case-${++sequence}`;
  const config: HarnessEntry['config'] = {
    id: configInput.id ?? key,
    pageSize: configInput.pageSize ?? 10,
    maxPages: configInput.maxPages ?? 3,
    initialStart: configInput.initialStart ?? 0,
    sourceKind: configInput.sourceKind ?? 'server',
    freshEdge: configInput.freshEdge ?? 'head',
    active: configInput.active ?? true,
    separateContent: configInput.separateContent ?? false,
    detachedScroller: configInput.detachedScroller ?? false,
    pillHost: configInput.pillHost ?? 'default',
    normalize: configInput.normalize ?? 'none',
    renderParts: configInput.renderParts ?? 1,
    rowHeight: configInput.rowHeight ?? 32,
    fetchByIdentity: configInput.fetchByIdentity ?? false,
    fetchDelayMs: configInput.fetchDelayMs ?? 0,
    overflowPageBy: configInput.overflowPageBy ?? 0,
    register: configInput.register ?? 'global',
    onLoadProgress: configInput.onLoadProgress ?? false,
    callbacks: configInput.callbacks ?? true,
    ...configInput,
  };
  const host = createHost(config, key);
  const events: HarnessEvent[] = [];
  const fetchCalls: FetchCall[] = [];
  const failNext = new Set<ErrorPhase>();
  const items = config.items
    ? config.items.map(cloneItem)
    : createItems(config.itemCount ?? 40);
  const entryShell = {
    key,
    config,
    root: host.root,
    scroller: host.scroller,
    content: host.content,
    explicitPillHost: host.explicitPillHost,
    fetchCalls,
    events,
    failNext,
    items,
    logicalCount: config.logicalCount ?? 0,
    active: config.active,
    pinnedItems: (config.pinnedItems ?? []).map(cloneItem),
    pauseNextPage: false,
    pauseNextIdentity: false,
    running: new Set<Promise<unknown>>(),
  } as Omit<HarnessEntry, 'list'>;

  const fetchPage = async (req: FetchPageRequest<TestQuery>): Promise<PageLoadResult<TestItem>> => {
    const phase = phaseOf(req);
    recordFetchCall(fetchCalls, req, phase);
    await waitForGate(entryShell as HarnessEntry, 'page');
    if (config.fetchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.fetchDelayMs));
    }
    if (failNext.delete(phase)) throw new Error(`${phase}-failure`);
    return pageFromRange(entryShell as HarnessEntry, req);
  };

  const source = config.sourceKind === 'local'
    ? localPageSource<TestItem, TestQuery>({
      loadAll: async (query, onProgress) => {
        const progressValues = [
          ...(config.progressByKeyword?.[query?.keyword ?? ''] ?? config.progressValues ?? []),
        ];
        const syntheticReq: FetchPageRequest<TestQuery> = {
          cursor: undefined,
          backward: false,
          limit: config.pageSize,
          query,
          ...(onProgress ? { onProgress } : {}),
        };
        const phase = phaseOf(syntheticReq);
        recordFetchCall(fetchCalls, syntheticReq, phase);
        await waitForGate(entryShell as HarnessEntry, 'page');
        if (config.fetchDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.fetchDelayMs));
        }
        if (failNext.delete('reset')) throw new Error('reset-failure');
        for (const loaded of progressValues) onProgress?.(loaded);
        if (entryShell.logicalCount > 0) {
          return createItems(entryShell.logicalCount);
        }
        return entryShell.items.map(cloneItem);
      },
      filter: (item, query) => !query?.keyword || item.label.includes(query.keyword),
      compare: (a, b) => a.order - b.order,
    })
    : serverPageSource(fetchPage, (page) => page);

  const store = config.selection?.storeKey
    ? sharedStores.get(config.selection.storeKey)
      ?? (() => {
        const created = new SelectionStore(config.selection?.storeMax);
        sharedStores.set(config.selection!.storeKey!, created);
        return created;
      })()
    : undefined;

  const pillHost = config.pillHost === 'false'
    ? false
    : config.pillHost === 'explicit'
      ? host.explicitPillHost
      : undefined;

  const normalize = normalizeFor(config);
  const options: BoundedListOptions<TestItem, TestQuery> = {
    id: config.id,
    scrollElement: host.scroller,
    ...(config.separateContent ? { contentElement: host.content } : {}),
    ...(pillHost === undefined ? {} : { pillHost }),
    ...(configInput.active === undefined ? {} : { isActive: () => entryShell.active }),
    ...(config.register === 'custom'
      ? {
        register: (instance: { readonly id: string; invalidate(): void | Promise<void> }) => {
          customRegistry.set(instance.id, instance);
          pushEvent(entryShell, 'register', instance.id);
          return () => {
            if (customRegistry.get(instance.id) === instance) customRegistry.delete(instance.id);
            pushEvent(entryShell, 'unregister', instance.id);
          };
        },
      }
      : {}),
    pageSize: config.pageSize,
    maxPages: config.maxPages,
    source,
    ...(config.fetchByIdentity
      ? {
        fetchByIdentity: async (ids: readonly string[]) => {
          pushEvent(entryShell, 'fetchByIdentity', ids);
          const snapshot = entryShell.items.map(cloneItem);
          await waitForGate(entryShell as HarnessEntry, 'identity');
          if (failNext.delete('refresh')) throw new Error('refresh-failure');
          const byId = new Map(snapshot.map((item) => [item.id, item] as const));
          return ids.flatMap((id) => {
            const item = byId.get(id);
            return item ? [cloneItem(item)] : [];
          });
        },
      }
      : {}),
    ...(normalize ? { normalize } : {}),
    identityOf: (item) => item.id,
    ...(configInput.freshEdge === undefined ? {} : { freshEdge: config.freshEdge }),
    ...(config.stickyPx === undefined ? {} : { stickyPx: config.stickyPx }),
    ...(config.reachPx === undefined ? {} : { reachPx: config.reachPx }),
    ...(config.settleFrames === undefined ? {} : { settleFrames: config.settleFrames }),
    renderItem: (item, context) => {
      const elements: HTMLElement[] = [];
      for (let part = 0; part < config.renderParts; part++) {
        const element = document.createElement('div');
        element.className = `bl-row bl-row-part-${part}`;
        element.dataset.id = item.id;
        element.dataset.part = String(part);
        element.dataset.index = String(context.index);
        element.dataset.identity = context.identity;
        element.dataset.selected = String(context.selected);
        element.dataset.selectable = String(context.selectable);
        element.dataset.previous = context.previous?.id ?? '';
        element.style.height = `${config.rowHeight + (item.order % 3) * 3}px`;
        const nested = document.createElement('span');
        nested.className = 'bl-row-label';
        nested.textContent = `${item.label}#${part}`;
        element.appendChild(nested);
        elements.push(element);
      }
      return elements;
    },
    ...(configInput.pinnedItems === undefined
      ? {}
      : { pinnedItems: () => entryShell.pinnedItems }),
    text: textFor(config),
    ...(config.selection
      ? {
        selection: {
          mode: config.selection.mode,
          ...(config.selection.max === undefined ? {} : { max: config.selection.max }),
          ...(store ? { store } : {}),
          ...(config.callbacks
            ? { onExceed: () => pushEvent(entryShell, 'onExceed', null) }
            : {}),
        },
      }
      : {}),
    ...(configInput.initialQuery === undefined ? {} : { initialQuery: config.initialQuery }),
    ...(config.callbacks
      ? {
        onActivate: (item: TestItem, event: Event) => pushEvent(entryShell, 'onActivate', {
          item,
          eventType: event.type,
          keyboard: event instanceof KeyboardEvent,
        }),
        onSelectionChange: (snapshot: SelectionSnapshot<TestItem>) =>
          pushEvent(entryShell, 'onSelectionChange', snapshot),
        onLoadStateChange: (state: BoundedListState) =>
          pushEvent(entryShell, 'onLoadStateChange', state),
        onStaleChange: (stale: boolean, pendingCount: number) =>
          pushEvent(entryShell, 'onStaleChange', { stale, pendingCount }),
        onItemsChanged: (changedItems: readonly TestItem[]) =>
          pushEvent(entryShell, 'onItemsChanged', changedItems),
        onError: (error: unknown, phase: ErrorPhase) =>
          pushEvent(entryShell, 'onError', { error, phase }),
        onEmptyPage: (direction: Direction) =>
          pushEvent(entryShell, 'onEmptyPage', direction),
        ...(config.onLoadProgress
          ? {
            onLoadProgress: (loaded: number) =>
              pushEvent(entryShell, 'onLoadProgress', loaded),
          }
          : {}),
      }
      : {}),
  };

  const list = createBoundedList(options);
  // 数据源、回调与测试命令必须共享同一个可变 entry；不能在这里展开复制，
  // 否则 pause/setItems/setActive 等命令只会改到 Map 中的副本。
  const entry = Object.assign(entryShell, { list }) as HarnessEntry;
  entries.set(key, entry);
  if (config.autoReset ?? true) await list.reset();
  return key;
}

function getEntry(key: string): HarnessEntry {
  const entry = entries.get(key);
  if (!entry) throw new Error(`Unknown BoundedList test case: ${key}`);
  return entry;
}

function start(entry: HarnessEntry, operation: () => Promise<unknown>): void {
  const promise = operation();
  recordPromise(entry, promise);
}

async function afterAnimationFrames(count = 2): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

const api = {
  createItems,
  mount,
  async dispose(key: string): Promise<void> {
    const entry = getEntry(key);
    entry.list.dispose();
    await afterAnimationFrames();
  },
  disposeNow(key: string): void {
    getEntry(key).list.dispose();
  },
  removeCase(key: string): void {
    const entry = getEntry(key);
    entry.list.dispose();
    entry.root.remove();
    entries.delete(key);
  },
  reset(key: string, options?: { query?: TestQuery; pinEdge?: boolean }): Promise<void> {
    return getEntry(key).list.reset(options);
  },
  startReset(key: string, options?: { query?: TestQuery; pinEdge?: boolean }): void {
    const entry = getEntry(key);
    start(entry, () => entry.list.reset(options));
  },
  loadMore(key: string, direction: 'forward' | 'backward'): Promise<void> {
    return getEntry(key).list.loadMore(direction);
  },
  startLoadMore(key: string, direction: 'forward' | 'backward'): void {
    const entry = getEntry(key);
    start(entry, () => entry.list.loadMore(direction));
  },
  setQuery(key: string, query: TestQuery, debounceMs?: number): void {
    getEntry(key).list.setQuery(
      query,
      debounceMs === undefined ? undefined : { debounceMs },
    );
  },
  invalidate(
    key: string,
    options?: { identities?: readonly string[]; count?: number },
  ): void {
    getEntry(key).list.invalidate(options);
  },
  invalidateMany(
    key: string,
    batches: readonly { identities?: readonly string[]; count?: number }[],
  ): void {
    const entry = getEntry(key);
    for (const options of batches) entry.list.invalidate(options);
  },
  invalidateAll(): void {
    invalidateAllBoundedLists();
  },
  upsertLocal(key: string, item: TestItem): void {
    getEntry(key).list.upsertLocal(cloneItem(item));
  },
  patchLabel(key: string, id: string, label: string): boolean {
    return getEntry(key).list.patch(id, (item) => ({ ...item, label }));
  },
  removeLocal(key: string, id: string): boolean {
    return getEntry(key).list.removeLocal(id);
  },
  render(key: string): void {
    getEntry(key).list.render();
  },
  scrollToIdentity(
    key: string,
    id: string,
    block?: 'center' | 'nearest',
  ): boolean {
    return getEntry(key).list.scrollToIdentity(id, block ? { block } : undefined);
  },
  state(key: string) {
    return getEntry(key).list.getState();
  },
  id(key: string): string {
    return getEntry(key).list.id;
  },
  registryIds(): string[] {
    return registeredBoundedListIds();
  },
  customRegistryIds(): string[] {
    return [...customRegistry.keys()];
  },
  customInvalidateAll(): void {
    for (const instance of [...customRegistry.values()]) {
      void Promise.resolve(instance.invalidate()).catch(() => undefined);
    }
  },
  events(key: string): HarnessEvent[] {
    return structuredClone(getEntry(key).events);
  },
  clearEvents(key: string): void {
    getEntry(key).events.length = 0;
  },
  fetchCalls(key: string): FetchCall[] {
    return structuredClone(getEntry(key).fetchCalls);
  },
  clearFetchCalls(key: string): void {
    getEntry(key).fetchCalls.length = 0;
  },
  setActive(key: string, active: boolean): void {
    getEntry(key).active = active;
  },
  setItems(key: string, items: readonly TestItem[]): void {
    getEntry(key).items = items.map(cloneItem);
  },
  setPinnedItems(key: string, items: readonly TestItem[]): void {
    getEntry(key).pinnedItems = items.map(cloneItem);
  },
  failNext(key: string, phase: ErrorPhase): void {
    getEntry(key).failNext.add(phase);
  },
  pauseNextPage(key: string): void {
    getEntry(key).pauseNextPage = true;
  },
  pauseNextIdentity(key: string): void {
    getEntry(key).pauseNextIdentity = true;
  },
  resolvePage(key: string): void {
    const gate = getEntry(key).pageGate;
    if (!gate) throw new Error('No paused page request');
    gate.resolve();
  },
  rejectPage(key: string, message = 'page-rejected'): void {
    const gate = getEntry(key).pageGate;
    if (!gate) throw new Error('No paused page request');
    gate.reject(new Error(message));
  },
  resolveIdentity(key: string): void {
    const gate = getEntry(key).identityGate;
    if (!gate) throw new Error('No paused identity request');
    gate.resolve();
  },
  rejectIdentity(key: string, message = 'identity-rejected'): void {
    const gate = getEntry(key).identityGate;
    if (!gate) throw new Error('No paused identity request');
    gate.reject(new Error(message));
  },
  hasPageGate(key: string): boolean {
    return Boolean(getEntry(key).pageGate);
  },
  hasIdentityGate(key: string): boolean {
    return Boolean(getEntry(key).identityGate);
  },
  async waitForIdle(key: string): Promise<void> {
    const entry = getEntry(key);
    while (entry.running.size > 0) {
      await Promise.allSettled([...entry.running]);
    }
    await afterAnimationFrames();
  },
  async frames(count = 2): Promise<void> {
    await afterAnimationFrames(count);
  },
  async resetAndDisposeBeforeFrame(key: string): Promise<{
    scrollHeight: number;
    clientHeight: number;
  }> {
    const entry = getEntry(key);
    await entry.list.reset();
    entry.scroller.scrollTop = 0;
    entry.list.dispose();
    return {
      scrollHeight: entry.scroller.scrollHeight,
      clientHeight: entry.scroller.clientHeight,
    };
  },
  setScrollTop(key: string, value: number): void {
    getEntry(key).scroller.scrollTop = value;
  },
  expandRow(key: string, id: string, extraHeight: number, dispatchLoad = true): void {
    const entry = getEntry(key);
    const row = entry.content.querySelector<HTMLElement>(`.bl-row[data-id="${CSS.escape(id)}"]`);
    if (!row) throw new Error(`Row ${id} not found`);
    row.style.height = `${row.getBoundingClientRect().height + extraHeight}px`;
    if (dispatchLoad) {
      row.dispatchEvent(new Event('load', { bubbles: false }));
    }
  },
  scrollThenLoadSameFrame(key: string, scrollTop: number, id: string, extraHeight: number): void {
    const entry = getEntry(key);
    const row = entry.content.querySelector<HTMLElement>(`.bl-row[data-id="${CSS.escape(id)}"]`);
    if (!row) throw new Error(`Row ${id} not found`);
    entry.scroller.scrollTop = scrollTop;
    entry.scroller.dispatchEvent(new Event('scroll'));
    row.style.height = `${row.getBoundingClientRect().height + extraHeight}px`;
    row.dispatchEvent(new Event('load', { bubbles: false }));
  },
  scrollMetrics(key: string) {
    const { scroller } = getEntry(key);
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      distanceToBottom: Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
    };
  },
  rootConnected(key: string): boolean {
    return getEntry(key).root.isConnected;
  },
  rowCount(key: string): number {
    return getEntry(key).content.querySelectorAll('[data-bsw-key]').length;
  },
  logicalElementCount(key: string): number {
    return getEntry(key).content.querySelectorAll('.bl-row').length;
  },
  rowIds(key: string): string[] {
    return Array.from(getEntry(key).content.querySelectorAll<HTMLElement>('[data-bsw-key]'))
      .map((element) => element.dataset.id ?? '');
  },
  allPartIds(key: string): string[] {
    return Array.from(getEntry(key).content.querySelectorAll<HTMLElement>('.bl-row'))
      .map((element) => `${element.dataset.id}:${element.dataset.part}`);
  },
  focusedIds(key: string): string[] {
    return Array.from(getEntry(key).content.querySelectorAll<HTMLElement>('.bsw-row-focused'))
      .map((element) => element.dataset.id ?? '');
  },
  pillInfo(key: string) {
    const entry = getEntry(key);
    const pill = entry.root.querySelector<HTMLElement>('.list-updated-pill');
    return {
      exists: Boolean(pill),
      visible: Boolean(pill && !pill.classList.contains('hidden')),
      text: pill?.textContent ?? '',
      parentClass: pill?.parentElement?.className ?? '',
    };
  },
  clickPill(key: string): void {
    getEntry(key).root.querySelector<HTMLElement>('.list-updated-pill')?.click();
  },
  eventTypes(key: string): string[] {
    return getEntry(key).events.map((event) => event.type);
  },
  caseSelector(key: string): string {
    return `[data-case="${key}"]`;
  },
};

declare global {
  interface Window {
    boundedListTestHarness: typeof api;
  }
}

window.boundedListTestHarness = api;
document.documentElement.dataset.ready = 'true';
