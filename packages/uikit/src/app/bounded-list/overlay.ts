// 本地层：还没有被服务端确认的本端写入（乐观发送、就地删除）。
//
// 这是整个组件里唯一保存「本地事实」的地方，语义只有一条：
//
//   渲染序列 = 权威窗口 叠加 本地层
//
// 本地层**不写进 PageWindow**，所以任何一次服务端响应落地都不会破坏它，组件也就
// 不需要「重放」机制。两种记账：
// - put：这条身份要以本地值渲染，并且位置固定在新鲜端（本端发送要立刻出现在最前/最后；
//   窗口里已有同身份时等价于「移到新鲜端并改内容」，这正是发消息后会话置顶的语义）。
// - drop：这条身份不渲染（本端删除、乐观发送失败撤回）。
//
// 生命周期只有一条规则：**一次覆盖首页的权威请求落地后，比它更早的本地记账全部作废**
// （见 settle）。远端已经给出了包含这段时间的新事实，本地猜测就该让位，这样本地层
// 不会无限积累，也不需要逐条判断「服务端是不是已经确认了它」。

import type { Edge } from './types';

interface OverlayEntry<T> {
  readonly seq: number;
  /** null = 删除墓碑。 */
  readonly item: T | null;
}

export class LocalOverlay<T> {
  /** Map 的插入序即记账序；重复 put 会先删后插，把该身份移到最后（也就是最靠新鲜端）。 */
  private entries = new Map<string, OverlayEntry<T>>();
  private seq = 0;

  /** 上限只是兜底：正常场景下本地层只有个位数条目。超出时静默丢弃最旧的一条。 */
  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** 当前记账水位，交给 settle 判断「哪些记账比这次请求更早」。 */
  mark(): number {
    return this.seq;
  }

  put(id: string, item: T): void {
    this.record(id, item);
  }

  drop(id: string): void {
    this.record(id, null);
  }

  clear(): void {
    this.entries.clear();
  }

  /** 丢弃 mark 之前（含）的记账：那段时间的本地猜测已被新的权威首页覆盖。 */
  settle(mark: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.seq <= mark) this.entries.delete(id);
    }
  }

  /**
   * 把本地层叠加到权威序列上：被记账的身份先从原位置摘掉，put 的条目再按记账序
   * 落到新鲜端（backward 端时最后记账的排在最前）。
   */
  apply(base: readonly T[], freshEdge: Edge, identityOf: (item: T) => string): readonly T[] {
    if (this.entries.size === 0) return base;
    const kept = base.filter((item) => !this.entries.has(identityOf(item)));
    const puts: T[] = [];
    for (const entry of this.entries.values()) {
      if (entry.item !== null) puts.push(entry.item);
    }
    if (puts.length === 0) return kept;
    return freshEdge === 'backward' ? [...puts.reverse(), ...kept] : [...kept, ...puts];
  }

  private record(id: string, item: T | null): void {
    this.entries.delete(id);
    this.entries.set(id, { seq: ++this.seq, item });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
