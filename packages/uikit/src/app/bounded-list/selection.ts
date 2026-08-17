// 共享选中态（设计方案 §4.2「选中态」、§6.2 转发弹窗双 tab 共享同一份选中集）。
//
// 多个 BoundedList 实例可以共享同一个 SelectionStore：任一实例改动它，
// 组件负责通知所有共享该 store 的实例重渲，调用方不再需要手工互调对方的 render。

export type ToggleResult = 'added' | 'removed' | 'rejected';

export class SelectionStore {
  private ids = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly max?: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }

  /** 已选达上限且该 id 当前未选中时返回 true（用于渲染时禁用未选项）。 */
  isExceeded(id: string): boolean {
    return this.max !== undefined && this.ids.size >= this.max && !this.ids.has(id);
  }

  snapshotIds(): ReadonlySet<string> {
    return new Set(this.ids);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 多选场景下翻转某个 id 的选中状态；达上限且当前未选中时拒绝。 */
  toggle(id: string): ToggleResult {
    if (this.ids.has(id)) {
      this.ids.delete(id);
      this.notify();
      return 'removed';
    }
    if (this.max !== undefined && this.ids.size >= this.max) return 'rejected';
    this.ids.add(id);
    this.notify();
    return 'added';
  }

  /** 精确移除某个 id；返回是否真的删掉了（只在删掉时通知）。 */
  delete(id: string): boolean {
    if (!this.ids.delete(id)) return false;
    this.notify();
    return true;
  }

  /** 单选场景：选中集替换为仅含该 id。已经正是这一项时不通知（重复点同一行不该整表重绘）。 */
  replaceSingle(id: string): void {
    if (this.ids.size === 1 && this.ids.has(id)) return;
    this.ids = new Set([id]);
    this.notify();
  }

  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.notify();
  }

  // 先快照再遍历：订阅者在回调里增删订阅时，本轮通知的对象集合是确定的
  // （新增的不会被本轮通知到，注销的仍会收到本轮通知），避免顺序相关的隐式契约。
  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
