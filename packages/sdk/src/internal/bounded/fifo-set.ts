/**
 * FifoSet<T> —— 容量受限的通用 FIFO 去重集合，元素为任意类型。
 *
 * 与 FifoMap 同源设计：基于原生 `Set` 实现，放弃「运行期字节上界可静态精确
 * 计算」这一属性；容量在构造时指定，size 永远不超过 capacity，超出容量时
 * 淘汰最早插入的元素（FIFO，不支持 reject/lru）。
 *
 * 元素相等性与原生 `Set` 完全一致（SameValueZero）。
 */

import type { BoundedStats } from './stats';

export interface FifoSetOptions {
  /** 最大容纳元素数；size 永不超过该值。 */
  readonly capacity: number;
}

export class FifoSet<T> {
  readonly capacity: number;

  private readonly set = new Set<T>();
  private _evictionCount = 0;

  constructor(options: FifoSetOptions) {
    this.capacity = Math.max(0, Math.floor(options.capacity));
  }

  get size(): number { return this.set.size; }
  get evictionCount(): number { return this._evictionCount; }
  get loadFactor(): number { return this.capacity === 0 ? 0 : this.set.size / this.capacity; }

  /**
   * 加入元素。已存在返回 true（幂等，不改变其 FIFO 顺序）。
   * @returns true 表示已加入（新增、幂等命中或淘汰最旧元素后写入）；
   *          false 仅在 capacity=0 时发生。
   */
  add(value: T): boolean {
    if (this.capacity === 0) return false;
    const isNew = !this.set.has(value);
    this.set.add(value);
    if (isNew && this.set.size > this.capacity) {
      const oldest = this.set.values().next().value as T;
      this.set.delete(oldest);
      this._evictionCount++;
    }
    return true;
  }

  has(value: T): boolean {
    return this.set.has(value);
  }

  delete(value: T): boolean {
    return this.set.delete(value);
  }

  clear(): void {
    this.set.clear();
  }

  forEach(cb: (value: T) => void): void {
    this.set.forEach(cb);
  }

  /** 返回所有元素（FIFO 插入顺序）。 */
  values(): T[] {
    return Array.from(this.set.values());
  }

  /** 取出全部元素（FIFO 插入顺序）并清空集合。用于「待拉取」队列原子排空。 */
  drain(): T[] {
    const out = this.values();
    this.clear();
    return out;
  }

  /** 与原生 Set 一致的默认迭代协议：`for...of` / 展开运算符按 FIFO 插入顺序产出元素。 */
  [Symbol.iterator](): IterableIterator<T> {
    return this.set[Symbol.iterator]();
  }

  stats(): BoundedStats {
    return {
      size: this.set.size,
      capacity: this.capacity,
      bucketCount: 1,
      bucketCapacity: this.capacity,
      rejectCount: 0,
      evictionCount: this._evictionCount,
      loadFactor: this.loadFactor,
    };
  }
}
