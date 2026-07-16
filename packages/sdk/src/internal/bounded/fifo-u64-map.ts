/**
 * FifoU64Map<V> —— 容量受限的 uint64 -> V FIFO 映射。
 *
 * 设计取舍：
 * - 不用定长 TypedArray 预分配槽位，改为直接基于原生 `Map` 实现，放弃了
 *   「运行期字节上界可静态精确计算」这一属性，换取实现简单、天然支持任意值
 *   类型、零哈希冲突处理成本。
 * - 仍然是「entry 数量」意义上的有界结构：capacity 在构造时指定，size 永远
 *   不超过 capacity；超出容量时淘汰最早插入的条目（FIFO，不支持 reject/lru）。
 * - key 统一为十进制 uint64 字符串（与项目内 uid / group_id / request_id 的
 *   惯例一致），内部按数值规范化（如 "007" 与 "7" 视为同一 key），避免字符串
 *   字面量差异导致的重复条目。
 *
 * 淘汰语义：原生 Map 的 `set()` 对已存在 key 更新 value 时不改变其插入顺序位置，
 * 因此对已存在 key 的重复写入不会重置其 FIFO 顺序。
 */

import { parseU64, u64ToString } from './u64';
import type { BoundedStats } from './stats';

export interface FifoU64MapOptions {
  /** 最大容纳条目数；size 永不超过该值。 */
  readonly capacity: number;
}

/** 单个 Map 条目的估算字节开销上界：key 字符串对象 + 原生 Map 内部槽位结构。 */
const ENTRY_OVERHEAD_BYTES = 96;

/** 估算 FifoU64Map 满载时的 JS 堆字节上界 = capacity * (条目结构开销 + perValueBytes)。 */
export function estimateFifoU64MapBytes(capacity: number, perValueBytes: number): number {
  const cap = Math.max(0, Math.floor(capacity));
  return cap * (ENTRY_OVERHEAD_BYTES + Math.max(0, perValueBytes));
}

/** 将十进制 uint64 字符串规范化（如 "007" -> "7"），非法输入直接抛 RangeError。 */
function canonicalKey(key: string): string {
  const { hi, lo } = parseU64(key);
  return u64ToString(hi, lo);
}

export class FifoU64Map<V = string> {
  readonly capacity: number;

  private readonly map = new Map<string, V>();
  private _evictionCount = 0;

  constructor(options: FifoU64MapOptions) {
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
  set(key: string, value: V): boolean {
    if (this.capacity === 0) return false;
    const k = canonicalKey(key);
    const isNew = !this.map.has(k);
    this.map.set(k, value);
    if (isNew && this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this._evictionCount++;
    }
    return true;
  }

  get(key: string): V | undefined {
    return this.map.get(canonicalKey(key));
  }

  has(key: string): boolean {
    return this.map.has(canonicalKey(key));
  }

  delete(key: string): boolean {
    return this.map.delete(canonicalKey(key));
  }

  clear(): void {
    this.map.clear();
  }

  /** 遍历所有条目（顺序为 FIFO 插入顺序）。 */
  forEach(cb: (value: V, key: string) => void): void {
    this.map.forEach((v, k) => cb(v, k));
  }

  /** 返回所有 key 的十进制字符串（FIFO 插入顺序）。 */
  keys(): string[] {
    return Array.from(this.map.keys());
  }

  stats(): BoundedStats {
    return {
      size: this.map.size,
      capacity: this.capacity,
      // 非 bucket 结构统一约定：bucketCount=1，bucketCapacity=capacity（见 stats.ts）。
      bucketCount: 1,
      bucketCapacity: this.capacity,
      // FifoU64Map 从不拒绝写入（capacity=0 除外，此时也无从谈起"拒绝计数"的诊断意义）。
      rejectCount: 0,
      evictionCount: this._evictionCount,
      loadFactor: this.loadFactor,
    };
  }
}
