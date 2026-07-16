/**
 * FifoMap<K, V> —— 容量受限的通用 FIFO 映射，key / value 均为任意类型。
 *
 * 设计取舍：
 * - 不用定长 TypedArray 预分配槽位，改为直接基于原生 `Map` 实现，放弃了
 *   「运行期字节上界可静态精确计算」这一属性，换取实现简单、天然支持任意
 *   key / value 类型、零哈希冲突处理成本。
 * - 仍然是「entry 数量」意义上的有界结构：capacity 在构造时指定，size 永远
 *   不超过 capacity；超出容量时淘汰最早插入的条目（FIFO，不支持 reject/lru）。
 * - key 相等性与原生 `Map` 完全一致（SameValueZero）：基本类型按值比较，
 *   对象按引用比较；不再局限于十进制 uint64 字符串，也不做任何规范化。
 *
 * 淘汰语义：原生 Map 的 `set()` 对已存在 key 更新 value 时不改变其插入顺序位置，
 * 因此对已存在 key 的重复写入不会重置其 FIFO 顺序。
 */

import type { BoundedStats } from './stats';

export interface FifoMapOptions {
  /** 最大容纳条目数；size 永不超过该值。 */
  readonly capacity: number;
}

export class FifoMap<K, V> {
  readonly capacity: number;

  private readonly map = new Map<K, V>();
  private _evictionCount = 0;

  constructor(options: FifoMapOptions) {
    this.capacity = Math.max(0, Math.floor(options.capacity));
  }

  get size(): number { return this.map.size; }
  get evictionCount(): number { return this._evictionCount; }
  get loadFactor(): number { return this.capacity === 0 ? 0 : this.map.size / this.capacity; }

  /**
   * 写入或更新 key。
   * @returns true 表示已写入（新增、更新或淘汰最旧条目后写入）；
   *          false 仅在 capacity=0 时发生（容量 0 的集合拒绝一切写入）。
   */
  set(key: K, value: V): boolean {
    if (this.capacity === 0) return false;
    const isNew = !this.map.has(key);
    this.map.set(key, value);
    if (isNew && this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
      this._evictionCount++;
    }
    return true;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** 遍历所有条目（顺序为 FIFO 插入顺序）。 */
  forEach(cb: (value: V, key: K) => void): void {
    this.map.forEach((v, k) => cb(v, k));
  }

  /** 返回所有 key（FIFO 插入顺序）。 */
  keys(): K[] {
    return Array.from(this.map.keys());
  }

  /** 返回所有 value（FIFO 插入顺序）。 */
  values(): V[] {
    return Array.from(this.map.values());
  }

  /** 返回所有 [key, value]（FIFO 插入顺序）。 */
  entries(): Array<[K, V]> {
    return Array.from(this.map.entries());
  }

  /** 与原生 Map 一致的默认迭代协议：`for...of` / 展开运算符按 FIFO 插入顺序产出 [key, value]。 */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map[Symbol.iterator]();
  }

  stats(): BoundedStats {
    return {
      size: this.map.size,
      capacity: this.capacity,
      // 非 bucket 结构统一约定：bucketCount=1，bucketCapacity=capacity（见 stats.ts）。
      bucketCount: 1,
      bucketCapacity: this.capacity,
      // FifoMap 从不拒绝写入（capacity=0 除外，此时也无从谈起"拒绝计数"的诊断意义）。
      rejectCount: 0,
      evictionCount: this._evictionCount,
      loadFactor: this.loadFactor,
    };
  }
}
