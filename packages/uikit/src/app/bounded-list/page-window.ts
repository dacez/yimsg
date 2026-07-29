// BoundedList 的数据窗口层：按页边界游标记账的有界滑动窗口。
//
// 记账规则（整页裁剪、跨页去重、就地增删改）原理见
// packages/uikit/docs/boundedlist/组件设计.md §8 与
// packages/uikit/docs/boundedlist/生产集成.md。
//
// 三条防御性约束（对应已修复缺陷，改动前请先看它们的成因）：
// - maxPages 至少为 1：否则 setInitial 放进来的页会被随后任意一次 mergeLive 整页裁光（BL-BUG-17）；
// - 空首页仍保留边界游标（fallback）：否则窗口为空时没有任何续翻锚点，只能发空游标（BL-BUG-10）；
// - 续翻拿到空页时强制把该端 hasMore 收敛为 false：服务端违反契约（空页却报还有更多）时
//   不会让触界检测无限补页（BL-BUG-01）。

import type { PageLoadResult } from './types';

interface WindowPage<T> {
  items: T[];
  readonly startCursor: string;
  readonly endCursor: string;
}

export class PageWindow<T> {
  private pages: WindowPage<T>[] = [];
  private before = false;
  private after = false;
  private totalCount = -1;
  /** 首页返回空结果时保留下来的边界游标，供「窗口暂时为空」时继续翻页。 */
  private fallbackStartCursor = '';
  private fallbackEndCursor = '';
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

  get hasMoreBefore(): boolean {
    return this.before;
  }

  get hasMoreAfter(): boolean {
    return this.after;
  }

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

  get backwardCursor(): string {
    return this.pages[0]?.startCursor ?? this.fallbackStartCursor;
  }

  get forwardCursor(): string {
    return this.pages.length ? this.pages[this.pages.length - 1].endCursor : this.fallbackEndCursor;
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
  private trimToHardBudget(edge: 'head' | 'tail'): number {
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
      if (edge === 'tail') this.before = true;
      else this.after = true;
    }
    return evicted;
  }

  reset(): void {
    this.pages = [];
    this.before = false;
    this.after = false;
    this.totalCount = -1;
    this.fallbackStartCursor = '';
    this.fallbackEndCursor = '';
  }

  setInitial(page: PageLoadResult<T>): void {
    const items = this.normalizeSourcePage(page.items);
    this.pages = items.length ? [{ items, startCursor: page.startCursor, endCursor: page.endCursor }] : [];
    // 空首页不占页位，但它的边界游标必须留下来：否则窗口为空时两端都没有续翻锚点。
    this.fallbackStartCursor = page.startCursor;
    this.fallbackEndCursor = page.endCursor;
    this.before = page.hasMoreBackward;
    this.after = page.hasMoreForward;
    this.totalCount = page.total ?? -1;
  }

  appendForward(page: PageLoadResult<T>): number {
    const items = this.normalizeSourcePage(page.items);
    this.dropIdsFromExistingPages(items);
    // 原始页非空但 normalize 后为空时仍保留该页游标，保证下一次续翻会前进而不是重复旧 cursor。
    if (page.items.length > 0) {
      this.pages.push({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    }
    // 空页 = 该方向已经没有数据，无论服务端怎么说都收敛为 false。
    this.after = page.items.length === 0 ? false : page.hasMoreForward;
    this.totalCount = page.total ?? this.totalCount;
    while (this.pages.length > this.maxPages) {
      this.pages.shift();
      this.before = true;
    }
    return items.length;
  }

  prependBackward(page: PageLoadResult<T>): number {
    const items = this.normalizeSourcePage(page.items);
    this.dropIdsFromExistingPages(items);
    if (page.items.length > 0) {
      this.pages.unshift({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    }
    this.before = page.items.length === 0 ? false : page.hasMoreBackward;
    this.totalCount = page.total ?? this.totalCount;
    while (this.pages.length > this.maxPages) {
      this.pages.pop();
      this.after = true;
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
    return changed;
  }

  /**
   * 把一条实时条目并入新鲜端所在的页（本地发送 / 转发成功回包）。
   * edge='tail' 并入尾页、超限裁首；edge='head' 并入首页、超限裁尾。
   * 并入前先做跨页去重，保证同一身份在窗口里至多出现一次。
   *
   * 调用方必须先确认该端 `hasMore` 已经是 `false`（窗口已经追平新鲜端）才能调用：
   * 这里不会替调用方把 `hasMore` 强行改成 `false`。窗口还没追平时贸然并入会把这条
   * 新条目错误地拼接在一段旧历史后面，还会顺带关掉真正的续翻——那才是数据丢失
   * 的成因，早前版本在这里无条件置 `false` 正是触发点。
   */
  mergeLive(item: T, edge: 'head' | 'tail'): number {
    this.dropIdsFromExistingPages([item]);
    if (this.pages.length === 0) {
      // 窗口里一页都没有：自建页只能用 fallback 游标；连 fallback 都没有（从未加载过）
      // 时两端都没有可用的续翻锚点，如实把 hasMore 置 false，避免带着空游标去请求。
      this.pages.push({
        items: this.normalize([item]),
        startCursor: this.fallbackStartCursor,
        endCursor: this.fallbackEndCursor,
      });
      if (!this.fallbackStartCursor) this.before = false;
      if (!this.fallbackEndCursor) this.after = false;
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
