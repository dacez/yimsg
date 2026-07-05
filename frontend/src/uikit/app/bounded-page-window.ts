// 有界滑动窗口的数据层：按页边界游标记账。
//
// 所有列表共用同一套数据窗口模型（详见 docs/frontend/有界消息流窗口设计方案.md）：
// - 服务端展示通道是 keyset 游标分页，游标对客户端不透明，禁止客户端解析或构造；
//   因此窗口以「页」为单位记账，每页保存服务端返回的 start_cursor / end_cursor；
// - 续翻向后（更靠后 / 更新）用尾页的 end_cursor，续翻向前（更靠前 / 更旧）用首页的 start_cursor；
// - 窗口最多保留 maxPages 页，超出时按整页从相反端裁剪，并把被裁端的 hasMore 置 true，
//   用户滚回去时用相邻保留页的边界游标重新拉取——内存窗口只是完整集合上的一个视图。
//
// 跨页去重（identityOf）：keyset 游标只能保证「单次查询快照内」翻页边界不重叠，前提是排序键
// 不可变（消息的 seq 绑定 msgId 永不变）。但会话 / 联系人的展示序键是可变的——会话收到新消息会
// 按新 seq 重排、联系人改名会按新 sort_key 重排，于是同一个实体会在不同时刻落到不同页，跨页拼接后
// 同一身份可能出现两次（典型路径见 §6）。给窗口传入稳定身份键 identityOf 后，新拉的页代表服务端
// 当前真值，入窗时用它覆盖其它保留页里的同身份旧条目（「用新的覆盖旧的」），从源头杜绝重复渲染。
//
// 渲染层（bounded-stream-window.ts）只做全量渲染：窗口有界，flatten 后的全部条目都进真实 DOM。

/** 列表分页请求结果中与窗口记账相关的部分，与 SDK 的 PageInfo 同构。 */
export interface PageLoadResult<T> {
  readonly items: ReadonlyArray<T>;
  readonly startCursor: string;
  readonly endCursor: string;
  readonly hasMoreBackward: boolean;
  readonly hasMoreForward: boolean;
}

interface WindowPage<T> {
  items: T[];
  readonly startCursor: string;
  readonly endCursor: string;
}

/**
 * 有界滑动窗口：按整页保存条目与不透明边界游标，超过 maxPages 时整页裁剪。
 * normalize 在每页入窗前对该页条目做归一化（消息列表用它去重 / 过滤删除态 / 按 seq 排序；
 * 其它列表用默认恒等）。
 */
export class BoundedPageWindow<T> {
  private pages: WindowPage<T>[] = [];
  hasMoreBefore = false;
  hasMoreAfter = false;

  constructor(
    private readonly maxPages: number,
    private readonly normalize: (items: ReadonlyArray<T>) => T[] = (items) => [...items],
    private readonly identityOf?: (item: T) => string,
  ) {}

  // 跨页去重：从其它已保留页里删掉与新入窗条目同身份的旧条目，保证整个窗口里每个身份至多出现一次。
  // 在新页 push / unshift 之前调用，所以只清旧页、不动新页本身（实现「用新的覆盖旧的」）。
  // 取舍：被清空条目的旧页会变短甚至变空，不再与服务端「整页」一一对应——但 hasMore 由服务端
  // PageInfo 决定、不依赖条数，续翻锚点用首 / 尾页的边界游标（空页仍保留有效游标），都不受影响；
  // 空页仍占一个 maxPages 名额可能让某真实页提前被裁，属可接受代价，换来「绝不重复显示」。
  private dropIdsFromExistingPages(incoming: ReadonlyArray<T>): void {
    if (!this.identityOf || this.pages.length === 0 || incoming.length === 0) return;
    const ids = new Set<string>();
    for (const item of incoming) ids.add(this.identityOf(item));
    for (const page of this.pages) {
      page.items = page.items.filter((item) => !ids.has(this.identityOf!(item)));
    }
  }

  reset(): void {
    this.pages = [];
    this.hasMoreBefore = false;
    this.hasMoreAfter = false;
  }

  /** 首屏是否已加载（窗口至少有一页）。 */
  get loaded(): boolean {
    return this.pages.length > 0;
  }

  /** flatten 后的全部条目（已按入窗顺序拼接），供渲染层全量渲染。 */
  get items(): T[] {
    const all: T[] = [];
    for (const page of this.pages) all.push(...page.items);
    return all;
  }

  get count(): number {
    let total = 0;
    for (const page of this.pages) total += page.items.length;
    return total;
  }

  /** 续翻向前（更旧 / 更靠前）使用的游标：首页的 start_cursor。 */
  get backwardCursor(): string {
    return this.pages[0]?.startCursor ?? '';
  }

  /** 续翻向后（更新 / 更靠后）使用的游标：尾页的 end_cursor。 */
  get forwardCursor(): string {
    return this.pages.length ? this.pages[this.pages.length - 1].endCursor : '';
  }

  /** 设置初始页（打开 / 重拉时调用）：清空窗口后放入这一页。 */
  setInitial(page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.pages = items.length ? [{ items, startCursor: page.startCursor, endCursor: page.endCursor }] : [];
    this.hasMoreBefore = page.hasMoreBackward;
    this.hasMoreAfter = page.hasMoreForward;
  }

  /** 向尾部追加新一页；超过 maxPages 时整页裁掉首部并标记 hasMoreBefore。 */
  appendForward(page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.dropIdsFromExistingPages(items);
    if (items.length) this.pages.push({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    this.hasMoreAfter = page.hasMoreForward;
    while (this.pages.length > this.maxPages) {
      this.pages.shift();
      this.hasMoreBefore = true;
    }
  }

  /** 向头部插入更旧一页；超过 maxPages 时整页裁掉尾部并标记 hasMoreAfter。 */
  prependBackward(page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.dropIdsFromExistingPages(items);
    if (items.length) this.pages.unshift({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    this.hasMoreBefore = page.hasMoreBackward;
    while (this.pages.length > this.maxPages) {
      this.pages.pop();
      this.hasMoreAfter = true;
    }
  }

  /**
   * 就地更新窗口内所有匹配条目（局部状态变更，如标记已读清未读），用 update 的返回值替换。
   * 不改变页/游标结构，避免整列表重拉与重排。返回是否命中至少一条。
   */
  updateMatching(match: (item: T) => boolean, update: (item: T) => T): boolean {
    let changed = false;
    for (const page of this.pages) {
      for (let i = 0; i < page.items.length; i++) {
        if (match(page.items[i])) {
          page.items[i] = update(page.items[i]);
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * 就地删除窗口内所有匹配条目（局部删除，如删除会话 / 消息），剩余条目自然往上补齐。
   * 不改变页/游标结构（页可能变短甚至为空，但边界游标仍有效，续翻锚点不受影响）。返回是否命中。
   */
  removeMatching(match: (item: T) => boolean): boolean {
    let changed = false;
    for (const page of this.pages) {
      const before = page.items.length;
      page.items = page.items.filter((item) => !match(item));
      if (page.items.length !== before) changed = true;
    }
    return changed;
  }

  /**
   * 把一条实时条目并入尾页（本地发送 / 转发成功回包）。窗口为空时自建一页。
   * 归一化在尾页内进行（消息列表据此去重并按 seq 排序），超过 maxPages 时整页裁首。
   */
  appendLive(item: T): void {
    if (this.pages.length === 0) {
      this.pages.push({ items: this.normalize([item]), startCursor: '', endCursor: '' });
    } else {
      const tail = this.pages[this.pages.length - 1];
      tail.items = this.normalize([...tail.items, item]);
    }
    while (this.pages.length > this.maxPages) {
      this.pages.shift();
      this.hasMoreBefore = true;
    }
  }
}
