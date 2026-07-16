/**
 * BoundedU64Set —— 固定容量的 uint64 集合，与 BoundedU64Map 共用同一套
 * 开放寻址 + 固定桶 + 桶内线性扫描布局，但不保存 value，专用于「待拉取 / 在飞」
 * 这类去重队列状态。
 *
 * 默认 reject 策略：容量满时 add() 返回 false（调用方据此抛错或丢弃），
 * 不允许新 key 淘汰已有 key。
 */

import { hashU64, parseU64, u64Equal, u64ToString } from './u64';
import { computeBoundedCapacity } from './bounded-u64-map';
import type { BoundedStats } from './stats';

const STATE_EMPTY = 0;
const STATE_OCCUPIED = 1;

const KEY_HI_BYTES = 4;
const KEY_LO_BYTES = 4;
const STATE_BYTES = 1;

export interface BoundedU64SetOptions {
  readonly capacity: number;
  readonly bucketCapacity?: number;
  readonly loadFactor?: number;
}

/** 估算 BoundedU64Set 满载时的 JS 堆字节上界（仅固定 slot 结构，无 value）。 */
export function estimateBoundedU64SetBytes(
  capacity: number,
  bucketCapacity = 8,
  loadFactor = 1,
): number {
  const sized = computeBoundedCapacity(capacity, bucketCapacity, loadFactor);
  return sized.capacity * (KEY_HI_BYTES + KEY_LO_BYTES + STATE_BYTES);
}

export class BoundedU64Set {
  readonly bucketCount: number;
  readonly bucketCapacity: number;
  readonly capacity: number;

  private readonly mask: number;
  private readonly keysHi: Uint32Array;
  private readonly keysLo: Uint32Array;
  private readonly states: Uint8Array;

  private _size = 0;
  private _rejectCount = 0;

  constructor(options: BoundedU64SetOptions) {
    const sized = computeBoundedCapacity(
      Math.max(0, Math.floor(options.capacity)),
      options.bucketCapacity ?? 8,
      options.loadFactor ?? 1,
    );
    this.bucketCount = sized.bucketCount;
    this.bucketCapacity = sized.bucketCapacity;
    this.capacity = sized.capacity;
    this.mask = this.bucketCount - 1;
    this.keysHi = new Uint32Array(this.capacity);
    this.keysLo = new Uint32Array(this.capacity);
    this.states = new Uint8Array(this.capacity);
  }

  get size(): number { return this._size; }
  get rejectCount(): number { return this._rejectCount; }
  get loadFactor(): number { return this.capacity === 0 ? 0 : this._size / this.capacity; }

  private baseOf(hi: number, lo: number): number {
    return (hashU64(hi, lo) & this.mask) * this.bucketCapacity;
  }

  /** 加入 key。已存在返回 true（幂等）；容量满（reject）返回 false。 */
  addKey(hi: number, lo: number): boolean {
    if (this.capacity === 0) { this._rejectCount++; return false; }
    const base = this.baseOf(hi, lo);
    let firstEmpty = -1;
    for (let i = 0; i < this.bucketCapacity; i++) {
      const idx = base + i;
      const st = this.states[idx];
      if (st === STATE_OCCUPIED && u64Equal(this.keysHi[idx], this.keysLo[idx], hi, lo)) return true;
      if (st === STATE_EMPTY && firstEmpty < 0) firstEmpty = idx;
    }
    if (firstEmpty < 0) { this._rejectCount++; return false; }
    this.keysHi[firstEmpty] = hi >>> 0;
    this.keysLo[firstEmpty] = lo >>> 0;
    this.states[firstEmpty] = STATE_OCCUPIED;
    this._size++;
    return true;
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
        this._size--;
        return true;
      }
    }
    return false;
  }

  // ── 字符串 key 便捷封装 ──────────────────────────────────────────────────
  add(key: string): boolean { const k = parseU64(key); return this.addKey(k.hi, k.lo); }
  has(key: string): boolean { const k = parseU64(key); return this.hasKey(k.hi, k.lo); }
  delete(key: string): boolean { const k = parseU64(key); return this.deleteKey(k.hi, k.lo); }

  /** 返回所有 key 的十进制字符串（slot 顺序）。 */
  keys(): string[] {
    const out: string[] = [];
    for (let idx = 0; idx < this.capacity; idx++) {
      if (this.states[idx] === STATE_OCCUPIED) out.push(u64ToString(this.keysHi[idx], this.keysLo[idx]));
    }
    return out;
  }

  /** 取出全部 key（十进制字符串）并清空集合。用于「待拉取」队列原子排空。 */
  drain(): string[] {
    const out = this.keys();
    this.clear();
    return out;
  }

  clear(): void {
    this.states.fill(STATE_EMPTY);
    this._size = 0;
  }

  stats(): BoundedStats {
    return {
      size: this._size,
      capacity: this.capacity,
      bucketCount: this.bucketCount,
      bucketCapacity: this.bucketCapacity,
      rejectCount: this._rejectCount,
      evictionCount: 0,
      loadFactor: this.loadFactor,
    };
  }
}
