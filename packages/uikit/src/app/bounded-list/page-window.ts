// BoundedList 的数据窗口层：按页边界游标记账的有界滑动窗口。
//
// 与旧版 bounded-page-window.ts 的差异（设计方案 §4.4、§8.1 #12 的落地）：
// - hasMoreBefore / hasMoreAfter 改为只读 getter，只能由本类内部的分页结果驱动，
//   外部不能再直写（消除「窗口边界状态失去单一来源」）；
// - 新增 total 透传（服务端 PageInfo.total，未知时为 -1）；
// - 新增 mergeLive，把 appendLive 泛化到「新鲜端可以是 head 也可以是 tail」
//   （旧版 appendLive 只支持 tail，见设计方案 §5.6）；
// - 新增 hasIdentity，供 invalidate 的「identities 与窗口内身份求交集」判定使用。
//
// 其余记账规则（整页裁剪、跨页去重、就地增删改）与旧版一致，原理见
// packages/uikit/docs/有界消息流窗口设计方案.md §2.3、§7.1、§7.2。

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

  constructor(
    private readonly maxPages: number,
    private readonly normalize: (items: readonly T[]) => T[] = (items) => [...items],
    private readonly identityOf?: (item: T) => string,
  ) {}

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
    return this.pages[0]?.startCursor ?? '';
  }

  get forwardCursor(): string {
    return this.pages.length ? this.pages[this.pages.length - 1].endCursor : '';
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

  reset(): void {
    this.pages = [];
    this.before = false;
    this.after = false;
    this.totalCount = -1;
  }

  setInitial(page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.pages = items.length ? [{ items, startCursor: page.startCursor, endCursor: page.endCursor }] : [];
    this.before = page.hasMoreBackward;
    this.after = page.hasMoreForward;
    this.totalCount = page.total ?? -1;
  }

  appendForward(page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.dropIdsFromExistingPages(items);
    if (items.length) this.pages.push({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    this.after = page.hasMoreForward;
    this.totalCount = page.total ?? this.totalCount;
    while (this.pages.length > this.maxPages) {
      this.pages.shift();
      this.before = true;
    }
  }

  prependBackward(page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.dropIdsFromExistingPages(items);
    if (items.length) this.pages.unshift({ items, startCursor: page.startCursor, endCursor: page.endCursor });
    this.before = page.hasMoreBackward;
    this.totalCount = page.total ?? this.totalCount;
    while (this.pages.length > this.maxPages) {
      this.pages.pop();
      this.after = true;
    }
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
   * 并入后新鲜端方向视为已追平最新，对应 hasMore 置为 false（§5.6）。
   */
  mergeLive(item: T, edge: 'head' | 'tail'): void {
    if (this.pages.length === 0) {
      this.pages.push({ items: this.normalize([item]), startCursor: '', endCursor: '' });
    } else if (edge === 'tail') {
      const tail = this.pages[this.pages.length - 1];
      tail.items = this.normalize([...tail.items, item]);
    } else {
      const head = this.pages[0];
      head.items = this.normalize([item, ...head.items]);
    }
    if (edge === 'tail') {
      this.after = false;
      while (this.pages.length > this.maxPages) {
        this.pages.shift();
        this.before = true;
      }
    } else {
      this.before = false;
      while (this.pages.length > this.maxPages) {
        this.pages.pop();
        this.after = true;
      }
    }
  }
}
