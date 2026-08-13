// 权威分页窗口：只保存服务端给过的整页，是列表的「远端事实」。
//
// 三条不变量（改动前先读 packages/uikit/docs/boundedlist/组件设计.md §4）：
// 1. 窗口最多 maxPages 页，每页最多 pageSize 条，所以条目数恒 ≤ pageSize×maxPages；
// 2. 同一身份在窗口里至多出现一次（并入新页时先把旧的同身份条目摘掉）；
// 3. 续翻锚点（headCursor / tailCursor）与页数组解耦维护，空页可以随时丢弃。
//
// 本类**不包含任何本地写入**：本端发送、乐观更新、就地删除都在 overlay.ts 里，
// 窗口只被「服务端响应」修改。这条边界是整个组件不需要重放机制的原因。

import type { Edge, PageLoadResult } from './types';

interface WindowPage<T> {
  items: T[];
  readonly startCursor: string;
  readonly endCursor: string;
}

export interface PageWindowOptions<T> {
  readonly maxPages: number;
  readonly pageSize: number;
  readonly identityOf: (item: T) => string;
  readonly normalize?: (items: readonly T[]) => T[];
}

export class PageWindow<T> {
  private pages: WindowPage<T>[] = [];
  private moreHead = false;
  private moreTail = false;
  private totalCount = -1;
  /**
   * 窗口两端的续翻锚点，显式维护而不是从 `pages[0]` / `pages[last]` 现算：
   * 页会因跨页去重、就地删除或 normalize 过滤而变空，空页必须能被丢弃（否则它白占
   * maxPages 名额，下一次淘汰淘掉的是另一端的真实数据页），锚点独立维护才做得到。
   */
  private headCursor = '';
  private tailCursor = '';

  constructor(private readonly opts: PageWindowOptions<T>) {}

  get hasMoreHead(): boolean {
    return this.moreHead;
  }

  get hasMoreTail(): boolean {
    return this.moreTail;
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

  /** 该端下一次续翻要用的游标；空串表示没有可用锚点。 */
  cursorFor(edge: Edge): string {
    return edge === 'head' ? this.headCursor : this.tailCursor;
  }

  hasMore(edge: Edge): boolean {
    return edge === 'head' ? this.moreHead : this.moreTail;
  }

  has(id: string): boolean {
    for (const page of this.pages) {
      for (const item of page.items) {
        if (this.opts.identityOf(item) === id) return true;
      }
    }
    return false;
  }

  reset(): void {
    this.pages = [];
    this.moreHead = false;
    this.moreTail = false;
    this.totalCount = -1;
    this.headCursor = '';
    this.tailCursor = '';
  }

  /** 首页落地：整窗替换，两端边界由这一页确立。 */
  setFirstPage(page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.pages = items.length ? [{ items, startCursor: page.startCursor, endCursor: page.endCursor }] : [];
    this.headCursor = page.startCursor;
    this.tailCursor = page.endCursor;
    this.moreHead = page.hasMoreHead;
    this.moreTail = page.hasMoreTail;
    this.totalCount = page.total ?? -1;
  }

  /** 往某一端续翻并入一页；超出 maxPages 时从另一端整页淘汰。 */
  extend(edge: Edge, page: PageLoadResult<T>): void {
    const items = this.normalize(page.items);
    this.dropIdentities(items);
    // 窗口一个锚点都没有（reset 之后直接续翻式重建）：这一页同时确立两端边界。
    if (!this.headCursor && !this.tailCursor) {
      this.headCursor = page.startCursor;
      this.tailCursor = page.endCursor;
    }
    if (items.length > 0) {
      const entry = { items, startCursor: page.startCursor, endCursor: page.endCursor };
      if (edge === 'head') this.pages.unshift(entry);
      else this.pages.push(entry);
    }
    // 锚点与页位分开判断：源页非空 → 锚点必须前进（哪怕 normalize 把它滤空了），否则
    // 下一次续翻拿旧游标原地打转；源页真为空 → 该端已经没有数据，锚点不动、hasMore
    // 无论服务端怎么说都收敛为 false（防止触界检测无限补页）。
    const sourceEmpty = page.items.length === 0;
    if (edge === 'head') {
      if (!sourceEmpty) this.headCursor = page.startCursor;
      this.moreHead = sourceEmpty ? false : page.hasMoreHead;
    } else {
      if (!sourceEmpty) this.tailCursor = page.endCursor;
      this.moreTail = sourceEmpty ? false : page.hasMoreTail;
    }
    this.totalCount = page.total ?? this.totalCount;
    this.evict(edge);
  }

  /** 按身份就地替换（定向刷新落地）；返回是否命中。 */
  replace(id: string, item: T): boolean {
    let changed = false;
    for (const page of this.pages) {
      for (let i = 0; i < page.items.length; i++) {
        if (this.opts.identityOf(page.items[i]) !== id) continue;
        page.items[i] = item;
        changed = true;
      }
    }
    return changed;
  }

  /** 按身份就地删除（定向刷新发现该条已不存在）；返回是否命中。 */
  remove(id: string): boolean {
    let changed = false;
    for (const page of this.pages) {
      const before = page.items.length;
      page.items = page.items.filter((item) => this.opts.identityOf(item) !== id);
      if (page.items.length !== before) changed = true;
    }
    if (changed) this.dropEmptyPages();
    return changed;
  }

  private normalize(items: readonly T[]): T[] {
    const normalized = this.opts.normalize ? this.opts.normalize(items) : [...items];
    if (normalized.length > this.opts.pageSize) {
      throw new RangeError(`PageSource 返回 ${normalized.length} 条，超过本次 pageSize=${this.opts.pageSize}`);
    }
    return normalized;
  }

  /** 并入新页前把窗口里已有的同身份条目摘掉，保证不变量 2。 */
  private dropIdentities(incoming: readonly T[]): void {
    if (this.pages.length === 0 || incoming.length === 0) return;
    const ids = new Set(incoming.map((item) => this.opts.identityOf(item)));
    for (const page of this.pages) {
      page.items = page.items.filter((item) => !ids.has(this.opts.identityOf(item)));
    }
    this.dropEmptyPages();
  }

  private dropEmptyPages(): void {
    if (this.pages.every((page) => page.items.length > 0)) return;
    this.pages = this.pages.filter((page) => page.items.length > 0);
  }

  /** 超出 maxPages 时从 keepEdge 的对端整页淘汰，并把该端边界改回被淘汰之后的位置。 */
  private evict(keepEdge: Edge): void {
    while (this.pages.length > this.opts.maxPages) {
      if (keepEdge === 'head') {
        this.pages.pop();
        this.moreTail = true;
        this.tailCursor = this.pages[this.pages.length - 1].endCursor;
      } else {
        this.pages.shift();
        this.moreHead = true;
        this.headCursor = this.pages[0].startCursor;
      }
    }
  }
}
