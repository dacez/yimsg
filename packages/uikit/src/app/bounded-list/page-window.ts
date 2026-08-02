// BoundedList 的数据窗口层：按页边界游标记账的有界滑动窗口。
//
// 记账规则（整页裁剪、跨页去重、就地增删改）原理见
// packages/uikit/docs/boundedlist/组件设计.md §8 与
// packages/uikit/docs/boundedlist/生产集成.md。
//
// 三条防御性约束（对应已修复缺陷，改动前请先看它们的成因）：
// - maxPages 至少为 1：否则 setInitial 放进来的页会被随后任意一次 mergeLive 整页裁光（BL-UNIT-BUG-017）；
// - 续翻锚点（headCursor / tailCursor）与 pages 解耦维护，见下方字段注释（BL-BUG-013 / BL-BUG-014）；
// - 续翻拿到空页时强制把该端 hasMore 收敛为 false：服务端违反契约（空页却报还有更多）时
//   不会让触界检测无限补页（BL-UNIT-BUG-001）。

import type { Edge, PageLoadResult } from './types';

interface WindowPage<T> {
  items: T[];
  readonly startCursor: string;
  readonly endCursor: string;
}

export class PageWindow<T> {
  private pages: WindowPage<T>[] = [];
  private moreHead = false;
  private moreTail = false;
  private totalCount = -1;
  /**
   * 窗口两端的续翻锚点，显式维护而不是从 `pages[0]` / `pages[last]` 现算。
   *
   * 「窗口边界在哪里」和「还剩哪些页」是两件事，绑在一起会产生两个问题：
   * - 页因跨页去重 / removeLocal 被删空后不能移除，否则边界游标就丢了；空页却仍占
   *   maxPages 名额，下一次续翻按 maxPages 淘汰时淘汰的是另一端的真实数据页——
   *   用户翻一页反而净损失一页内容。
   * - normalize 把整页过滤空时，为了让游标前进必须塞一个空页进来占位，否则下一次
   *   续翻会拿着旧游标原地打转；同样会挤占名额。
   * 锚点独立维护之后，空页可以随时丢弃，两个问题一起消失。
   */
  private headCursor = '';
  private tailCursor = '';
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly hardBudget: number;

  constructor(
    maxPages: number,
    private readonly normalize: (items: readonly T[]) => T[] = (items) => [...items],
    private readonly identityOf?: (item: T) => string,
    pageSize = Number.POSITIVE_INFINITY,
  ) {
    this.maxPages = Math.max(1, Math.floor(maxPages));
    this.pageSize = pageSize;
    this.hardBudget = pageSize * this.maxPages;
  }

  get hasMoreHead(): boolean {
    return this.moreHead;
  }

  get hasMoreTail(): boolean {
    return this.moreTail;
  }

  /** 窗口里还有没有页。空页会被立即回收，所以它等价于 `count > 0`。 */
  get loaded(): boolean {
    return this.pages.length > 0;
  }

  get total(): number {
    return this.totalCount;
  }

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

  /** 该端下一次续翻要用的游标。 */
  cursorFor(edge: Edge): string {
    return edge === 'head' ? this.headCursor : this.tailCursor;
  }

  /** 给定身份键是否命中窗口内某条目（invalidate 的交集判定用）。 */
  hasIdentity(id: string): boolean {
    if (!this.identityOf) return false;
    for (const page of this.pages) {
      for (const item of page.items) {
        if (this.identityOf(item) === id) return true;
      }
    }
    return false;
  }

  private dropIdsFromExistingPages(incoming: readonly T[]): void {
    if (!this.identityOf || this.pages.length === 0 || incoming.length === 0) return;
    const ids = new Set<string>();
    for (const item of incoming) ids.add(this.identityOf(item));
    for (const page of this.pages) {
      page.items = page.items.filter((item) => !ids.has(this.identityOf!(item)));
    }
    this.dropEmptyPages();
  }

  /**
   * 丢弃被删空的页。空页不贡献任何可见条目，却会挤占 maxPages 名额：留着它，
   * 下一次续翻按 maxPages 淘汰时淘汰的就是另一端的真实数据页。
   * 续翻锚点由 headCursor / tailCursor 独立维护，这里不需要为了保住游标而留空页。
   */
  private dropEmptyPages(): void {
    if (this.pages.every((page) => page.items.length > 0)) return;
    this.pages = this.pages.filter((page) => page.items.length > 0);
  }

  private normalizeSourcePage(items: readonly T[]): T[] {
    const normalized = this.normalize(items);
    if (normalized.length > this.pageSize) {
      throw new RangeError(
        `PageSource 返回 ${normalized.length} 条，超过本次 pageSize=${this.pageSize}`,
      );
    }
    return normalized;
  }

  /**
   * 实时并入不会带来新的服务端游标，所以允许新鲜端所在页临时变大，但整个窗口仍必须
   * 遵守 pageSize×maxPages 硬预算。超出时从非新鲜端逐条裁剪，并由上层安排权威 reset
   * 修复被裁边界的游标。
   */
  private trimToHardBudget(edge: Edge): number {
    if (!Number.isFinite(this.hardBudget)) return 0;
    let remaining = Math.max(0, this.count - this.hardBudget);
    const evicted = remaining;
    while (remaining > 0 && this.pages.length > 0) {
      const pageIndex = edge === 'tail' ? 0 : this.pages.length - 1;
      const page = this.pages[pageIndex];
      const take = Math.min(remaining, page.items.length);
      if (edge === 'tail') page.items.splice(0, take);
      else page.items.splice(page.items.length - take, take);
      remaining -= take;
      if (page.items.length === 0) this.pages.splice(pageIndex, 1);
    }
    if (evicted > 0) {
      if (edge === 'tail') this.moreHead = true;
      else this.moreTail = true;
    }
    return evicted;
  }

  reset(): void {
    this.pages = [];
    this.moreHead = false;
    this.moreTail = false;
    this.totalCount = -1;
    this.headCursor = '';
    this.tailCursor = '';
  }

  setInitial(page: PageLoadResult<T>): void {
    const items = this.normalizeSourcePage(page.items);
    this.pages = items.length ? [{ items, startCursor: page.startCursor, endCursor: page.endCursor }] : [];
    // 首页的两个边界即窗口两端的锚点；首页为空（或被 normalize 滤空）时同样成立，
    // 窗口暂时没有条目但边界是确定的。
    this.headCursor = page.startCursor;
    this.tailCursor = page.endCursor;
    this.moreHead = page.hasMoreHead;
    this.moreTail = page.hasMoreTail;
    this.totalCount = page.total ?? -1;
  }

  /** 往尾部续翻并入一页（wire 上的 forward 分页，恒等于本窗口的 tail 端）。 */
  appendTail(page: PageLoadResult<T>): number {
    const items = this.normalizeSourcePage(page.items);
    this.dropIdsFromExistingPages(items);
    // 窗口一个锚点都没有（reset 之后直接续翻式重建）：这一页同时确立两端边界。
    if (!this.headCursor && !this.tailCursor) {
      this.headCursor = page.startCursor;
      this.tailCursor = page.endCursor;
    }
    // 锚点与页位分开判断，两个条件不同：
    // - 源页非空 → 锚点必须前进（哪怕 normalize 把它滤空了），否则下一次续翻拿旧游标原地打转；
    //   源页真为空 → 锚点保持不动，前进会跳过尚未加载的数据。
    // - normalize 后有条目 → 才占一个 maxPages 页位；滤空的页不入窗。
    if (items.length > 0) {
      this.pages.push({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    }
    if (page.items.length > 0) this.tailCursor = page.endCursor;
    // 空页 = 该方向已经没有数据，无论服务端怎么说都收敛为 false。
    this.moreTail = page.items.length === 0 ? false : page.hasMoreTail;
    this.totalCount = page.total ?? this.totalCount;
    while (this.pages.length > this.maxPages) {
      this.pages.shift();
      this.moreHead = true;
      this.headCursor = this.pages[0].startCursor;
    }
    return items.length;
  }

  /** 往头部续翻并入一页（wire 上的 backward 分页，恒等于本窗口的 head 端）。 */
  prependHead(page: PageLoadResult<T>): number {
    const items = this.normalizeSourcePage(page.items);
    this.dropIdsFromExistingPages(items);
    // 窗口一个锚点都没有（reset 之后直接续翻式重建）：这一页同时确立两端边界。
    if (!this.headCursor && !this.tailCursor) {
      this.headCursor = page.startCursor;
      this.tailCursor = page.endCursor;
    }
    if (items.length > 0) {
      this.pages.unshift({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    }
    if (page.items.length > 0) this.headCursor = page.startCursor;
    this.moreHead = page.items.length === 0 ? false : page.hasMoreHead;
    this.totalCount = page.total ?? this.totalCount;
    while (this.pages.length > this.maxPages) {
      this.pages.pop();
      this.moreTail = true;
      this.tailCursor = this.pages[this.pages.length - 1].endCursor;
    }
    return items.length;
  }

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

  removeMatching(match: (item: T) => boolean): boolean {
    let changed = false;
    for (const page of this.pages) {
      const before = page.items.length;
      page.items = page.items.filter((item) => !match(item));
      if (page.items.length !== before) changed = true;
    }
    if (changed) this.dropEmptyPages();
    return changed;
  }

  /**
   * 把一条实时条目并入新鲜端所在的页（本地发送 / 转发成功回包）。
   * edge='tail' 并入尾页、超限裁首；edge='head' 并入首页、超限裁尾。
   * 并入前先做跨页去重，保证同一身份在窗口里至多出现一次。
   *
   * 调用方必须先确认该端 `hasMore` 已经是 `false`（窗口已经追平新鲜端）才能调用：
   * 这里不会替调用方把 `hasMore` 强行改成 `false`。窗口还没追平时贸然并入会把这条
   * 新条目错误地拼接在一段旧历史后面，还会顺带关掉真正的续翻，造成数据丢失。
   */
  mergeLive(item: T, edge: Edge): number {
    this.dropIdsFromExistingPages([item]);
    if (this.pages.length === 0) {
      // 窗口里一页都没有：自建页沿用当前窗口边界；连边界都没有（从未加载过）时
      // 两端都没有可用的续翻锚点，如实把 hasMore 置 false，避免带着空游标去请求。
      this.pages.push({
        items: this.normalize([item]),
        startCursor: this.headCursor,
        endCursor: this.tailCursor,
      });
      if (!this.headCursor) this.moreHead = false;
      if (!this.tailCursor) this.moreTail = false;
    } else if (edge === 'tail') {
      const tail = this.pages[this.pages.length - 1];
      tail.items = this.normalize([...tail.items, item]);
    } else {
      const head = this.pages[0];
      head.items = this.normalize([item, ...head.items]);
    }
    return this.trimToHardBudget(edge);
  }
}
