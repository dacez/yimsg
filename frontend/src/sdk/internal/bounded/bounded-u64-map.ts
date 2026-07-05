/**
 * BoundedU64Map<V> —— 真正固定容量的 uint64 -> V 映射。
 *
 * 设计目标（见 AGENTS.md「有界集合」约束）：
 * - 真正固定容量、固定 bucket、固定 slot，不使用 JS 原生无界 Map 作为底层存储。
 * - 内存静态可估算：容量在构造时确定，运行期不再增长。
 * - 结构易于跨语言（Rust/Go/C）复刻：开放寻址 + 固定桶 + 桶内线性扫描，
 *   无链表、无动态 chaining、无堆碎片。
 *
 * 布局（length 均为 capacity = bucketCount * bucketCapacity）：
 *   keysHi: Uint32Array   —— key 高 32 位
 *   keysLo: Uint32Array   —— key 低 32 位
 *   states: Uint8Array    —— 0=EMPTY，1=OCCUPIED
 *   seqs:   Float64Array  —— FIFO/LRU 顺序计数（reject 策略不分配）
 *   values: Array<V>      —— 值引用槽
 *
 * bucket 选择：`hashU64(hi, lo) & (bucketCount - 1)`，bucketCount 必须是 2 的幂。
 * 查找 / 写入只在目标 bucket 的 bucketCapacity 个槽位内线性扫描，天然支持后续
 * 每 bucket 一把锁；TypeScript 版本单线程，不需要锁。
 */

import { hashU64, nextPow2, parseU64, u64Equal, u64ToString } from './u64';
import type { BoundedStats } from './stats';

export type EvictionPolicy = 'reject' | 'fifo' | 'lru';

const STATE_EMPTY = 0;
const STATE_OCCUPIED = 1;

/** 每个 slot 的固定结构开销（字节），用于内存估算。 */
const KEY_HI_BYTES = 4;
const KEY_LO_BYTES = 4;
const STATE_BYTES = 1;
const SEQ_BYTES = 8;
/** values JS 数组中单个引用槽的指针字节数。 */
const VALUE_REF_BYTES = 8;

export interface BoundedU64MapOptions {
  /** 期望至少容纳的条目数；实际容量会向上对齐到 bucketCount(2^n) * bucketCapacity。 */
  readonly capacity: number;
  /** 每桶槽位数，默认 8。 */
  readonly bucketCapacity?: number;
  /** 淘汰策略，默认 'reject'。 */
  readonly eviction?: EvictionPolicy;
  /**
   * 期望最大负载因子（0,1]，默认 1。
   * 小于 1 时在期望容量基础上预留 headroom，降低单 bucket 溢出概率
   * （reject 策略下尤其重要：bucket 提前填满会拒绝本可接纳的 key）。
   */
  readonly loadFactor?: number;
}

/** 计算给定参数下的实际固定容量（bucketCount * bucketCapacity）。纯函数，供内存估算复用。 */
export function computeBoundedCapacity(
  capacity: number,
  bucketCapacity = 8,
  loadFactor = 1,
): { bucketCount: number; bucketCapacity: number; capacity: number } {
  const safeBucketCap = Math.max(1, Math.floor(bucketCapacity));
  const safeLoad = loadFactor > 0 && loadFactor <= 1 ? loadFactor : 1;
  const desiredSlots = Math.max(0, Math.ceil(capacity / safeLoad));
  // 期望容量为 0 时不分配任何 bucket（容量 0 集合拒绝一切写入），保证内存估算可归零。
  if (desiredSlots <= 0) return { bucketCount: 0, bucketCapacity: safeBucketCap, capacity: 0 };
  const bucketCount = nextPow2(Math.ceil(desiredSlots / safeBucketCap));
  return { bucketCount, bucketCapacity: safeBucketCap, capacity: bucketCount * safeBucketCap };
}

/**
 * 估算 BoundedU64Map 满载时的 JS 堆字节上界。
 * = capacity * (固定 slot 结构开销 + value 引用) + capacity * perValueBytes
 */
export function estimateBoundedU64MapBytes(
  capacity: number,
  perValueBytes: number,
  bucketCapacity = 8,
  eviction: EvictionPolicy = 'reject',
  loadFactor = 1,
): number {
  const sized = computeBoundedCapacity(capacity, bucketCapacity, loadFactor);
  const seqBytes = eviction === 'reject' ? 0 : SEQ_BYTES;
  const slotStruct = KEY_HI_BYTES + KEY_LO_BYTES + STATE_BYTES + seqBytes + VALUE_REF_BYTES;
  return sized.capacity * slotStruct + sized.capacity * Math.max(0, perValueBytes);
}

export class BoundedU64Map<V> {
  readonly bucketCount: number;
  readonly bucketCapacity: number;
  readonly capacity: number;
  readonly eviction: EvictionPolicy;

  private readonly mask: number;
  private readonly keysHi: Uint32Array;
  private readonly keysLo: Uint32Array;
  private readonly states: Uint8Array;
  private readonly seqs: Float64Array | null;
  private readonly values: Array<V | undefined>;

  private _size = 0;
  private _rejectCount = 0;
  private _evictionCount = 0;
  private seqCounter = 0;

  constructor(options: BoundedU64MapOptions) {
    const sized = computeBoundedCapacity(
      Math.max(0, Math.floor(options.capacity)),
      options.bucketCapacity ?? 8,
      options.loadFactor ?? 1,
    );
    this.bucketCount = sized.bucketCount;
    this.bucketCapacity = sized.bucketCapacity;
    this.capacity = sized.capacity;
    this.mask = this.bucketCount - 1;
    this.eviction = options.eviction ?? 'reject';

    this.keysHi = new Uint32Array(this.capacity);
    this.keysLo = new Uint32Array(this.capacity);
    this.states = new Uint8Array(this.capacity);
    this.seqs = this.eviction === 'reject' ? null : new Float64Array(this.capacity);
    this.values = new Array<V | undefined>(this.capacity).fill(undefined);
  }

  get size(): number { return this._size; }
  get rejectCount(): number { return this._rejectCount; }
  get evictionCount(): number { return this._evictionCount; }
  get loadFactor(): number { return this.capacity === 0 ? 0 : this._size / this.capacity; }

  private baseOf(hi: number, lo: number): number {
    return (hashU64(hi, lo) & this.mask) * this.bucketCapacity;
  }

  /**
   * 写入或更新 key。
   * @returns true 表示已写入（新增或更新或淘汰后写入）；false 表示 reject 策略下 bucket 已满被拒绝。
   */
  setKey(hi: number, lo: number, value: V): boolean {
    if (this.capacity === 0) { this._rejectCount++; return false; }
    const base = this.baseOf(hi, lo);
    let firstEmpty = -1;
    for (let i = 0; i < this.bucketCapacity; i++) {
      const idx = base + i;
      const st = this.states[idx];
      if (st === STATE_OCCUPIED && u64Equal(this.keysHi[idx], this.keysLo[idx], hi, lo)) {
        this.values[idx] = value;
        if (this.eviction === 'lru' && this.seqs) this.seqs[idx] = ++this.seqCounter;
        return true;
      }
      if (st === STATE_EMPTY && firstEmpty < 0) firstEmpty = idx;
    }
    if (firstEmpty >= 0) {
      this.occupy(firstEmpty, hi, lo, value);
      this._size++;
      return true;
    }
    // bucket 已满
    if (this.eviction === 'reject' || !this.seqs) {
      this._rejectCount++;
      return false;
    }
    // fifo / lru：淘汰本 bucket 内 seq 最小（最旧 / 最久未访问）的槽位
    let victim = base;
    let minSeq = this.seqs[base];
    for (let i = 1; i < this.bucketCapacity; i++) {
      const idx = base + i;
      if (this.seqs[idx] < minSeq) { minSeq = this.seqs[idx]; victim = idx; }
    }
    this.occupy(victim, hi, lo, value);
    this._evictionCount++;
    return true;
  }

  private occupy(idx: number, hi: number, lo: number, value: V): void {
    this.keysHi[idx] = hi >>> 0;
    this.keysLo[idx] = lo >>> 0;
    this.states[idx] = STATE_OCCUPIED;
    this.values[idx] = value;
    if (this.seqs) this.seqs[idx] = ++this.seqCounter;
  }

  getKey(hi: number, lo: number): V | undefined {
    const base = this.baseOf(hi, lo);
    for (let i = 0; i < this.bucketCapacity; i++) {
      const idx = base + i;
      if (this.states[idx] === STATE_OCCUPIED && u64Equal(this.keysHi[idx], this.keysLo[idx], hi, lo)) {
        if (this.eviction === 'lru' && this.seqs) this.seqs[idx] = ++this.seqCounter;
        return this.values[idx];
      }
    }
    return undefined;
  }

  hasKey(hi: number, lo: number): boolean {
    const base = this.baseOf(hi, lo);
    for (let i = 0; i < this.bucketCapacity; i++) {
      const idx = base + i;
      if (this.states[idx] === STATE_OCCUPIED && u64Equal(this.keysHi[idx], this.keysLo[idx], hi, lo)) return true;
    }
    return false;
  }

  deleteKey(hi: number, lo: number): boolean {
    const base = this.baseOf(hi, lo);
    for (let i = 0; i < this.bucketCapacity; i++) {
      const idx = base + i;
      if (this.states[idx] === STATE_OCCUPIED && u64Equal(this.keysHi[idx], this.keysLo[idx], hi, lo)) {
        this.states[idx] = STATE_EMPTY;
        this.values[idx] = undefined;
        this._size--;
        return true;
      }
    }
    return false;
  }

  // ── 字符串 key 便捷封装（key 为十进制 uint64 字符串）────────────────────────

  set(key: string, value: V): boolean { const k = parseU64(key); return this.setKey(k.hi, k.lo, value); }
  get(key: string): V | undefined { const k = parseU64(key); return this.getKey(k.hi, k.lo); }
  has(key: string): boolean { const k = parseU64(key); return this.hasKey(k.hi, k.lo); }
  delete(key: string): boolean { const k = parseU64(key); return this.deleteKey(k.hi, k.lo); }

  /** 清空全部条目（保留累计 rejectCount/evictionCount 供诊断）。 */
  clear(): void {
    this.states.fill(STATE_EMPTY);
    this.values.fill(undefined);
    this._size = 0;
    this.seqCounter = 0;
  }

  /** 遍历所有占用槽位（顺序为底层 slot 顺序，非插入顺序）。 */
  forEach(cb: (value: V, hi: number, lo: number) => void): void {
    for (let idx = 0; idx < this.capacity; idx++) {
      if (this.states[idx] === STATE_OCCUPIED) cb(this.values[idx] as V, this.keysHi[idx], this.keysLo[idx]);
    }
  }

  /** 返回所有 key 的十进制字符串（slot 顺序）。 */
  keys(): string[] {
    const out: string[] = [];
    for (let idx = 0; idx < this.capacity; idx++) {
      if (this.states[idx] === STATE_OCCUPIED) out.push(u64ToString(this.keysHi[idx], this.keysLo[idx]));
    }
    return out;
  }

  stats(): BoundedStats {
    return {
      size: this._size,
      capacity: this.capacity,
      bucketCount: this.bucketCount,
      bucketCapacity: this.bucketCapacity,
      rejectCount: this._rejectCount,
      evictionCount: this._evictionCount,
      loadFactor: this.loadFactor,
    };
  }
}
