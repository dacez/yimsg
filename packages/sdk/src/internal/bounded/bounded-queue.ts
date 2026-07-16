/**
 * BoundedQueue<V> —— 固定容量环形缓冲（ring buffer）FIFO 队列。
 *
 * 固定容量、无动态扩容、无链表，内存静态可估算。支持两种溢出策略：
 * - 'reject'：队列满时 enqueue() 返回 false，保留已有元素（默认）。
 * - 'overwrite_oldest'：队列满时丢弃队首最旧元素再写入新元素。
 */

import type { BoundedStats } from './stats';

export type QueueOverflowPolicy = 'reject' | 'overwrite_oldest';

/** 队列中单个引用槽的指针字节数（不含 value 对象本身）。 */
const VALUE_REF_BYTES = 8;

export interface BoundedQueueOptions {
  readonly capacity: number;
  readonly overflow?: QueueOverflowPolicy;
}

/** 估算 BoundedQueue 满载时的 JS 堆字节上界 = capacity * (引用槽 + perValueBytes)。 */
export function estimateBoundedQueueBytes(capacity: number, perValueBytes: number): number {
  const cap = Math.max(0, Math.floor(capacity));
  return cap * (VALUE_REF_BYTES + Math.max(0, perValueBytes));
}

export class BoundedQueue<V> {
  readonly capacity: number;
  readonly overflow: QueueOverflowPolicy;

  private readonly buffer: Array<V | undefined>;
  private head = 0; // 指向队首元素
  private tail = 0; // 指向下一个写入位置
  private _size = 0;
  private _rejectCount = 0;
  private _evictionCount = 0;

  constructor(options: BoundedQueueOptions) {
    this.capacity = Math.max(0, Math.floor(options.capacity));
    this.overflow = options.overflow ?? 'reject';
    this.buffer = new Array<V | undefined>(this.capacity).fill(undefined);
  }

  get size(): number { return this._size; }
  get rejectCount(): number { return this._rejectCount; }
  get evictionCount(): number { return this._evictionCount; }
  get loadFactor(): number { return this.capacity === 0 ? 0 : this._size / this.capacity; }
  get isFull(): boolean { return this._size >= this.capacity; }
  get isEmpty(): boolean { return this._size === 0; }

  /**
   * 入队。
   * @returns true 表示已入队（含 overwrite_oldest 覆盖后入队）；false 表示 reject 策略下队满被拒绝。
   */
  enqueue(value: V): boolean {
    if (this.capacity === 0) { this._rejectCount++; return false; }
    if (this._size >= this.capacity) {
      if (this.overflow === 'reject') { this._rejectCount++; return false; }
      // overwrite_oldest：丢弃队首
      this.buffer[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this._size--;
      this._evictionCount++;
    }
    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this.capacity;
    this._size++;
    return true;
  }

  /** 出队队首；空队列返回 undefined。 */
  dequeue(): V | undefined {
    if (this._size === 0) return undefined;
    const value = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this._size--;
    return value;
  }

  /** 查看队首但不出队。 */
  peek(): V | undefined {
    return this._size === 0 ? undefined : this.buffer[this.head];
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }

  /** 按 FIFO 顺序返回当前所有元素的快照。 */
  toArray(): V[] {
    const out: V[] = [];
    for (let i = 0; i < this._size; i++) {
      out.push(this.buffer[(this.head + i) % this.capacity] as V);
    }
    return out;
  }

  forEach(cb: (value: V, index: number) => void): void {
    for (let i = 0; i < this._size; i++) {
      cb(this.buffer[(this.head + i) % this.capacity] as V, i);
    }
  }

  stats(): BoundedStats {
    return {
      size: this._size,
      capacity: this.capacity,
      bucketCount: 1,
      bucketCapacity: this.capacity,
      rejectCount: this._rejectCount,
      evictionCount: this._evictionCount,
      loadFactor: this.loadFactor,
    };
  }
}
