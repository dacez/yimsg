import { describe, it, expect } from 'vitest';
import { BoundedQueue, estimateBoundedQueueBytes } from '../../../src/sdk/internal/bounded/bounded-queue';

describe('BoundedQueue', () => {
  it('enqueue/dequeue 保持 FIFO 顺序', () => {
    const q = new BoundedQueue<number>({ capacity: 4 });
    expect(q.enqueue(1)).toBe(true);
    expect(q.enqueue(2)).toBe(true);
    expect(q.enqueue(3)).toBe(true);
    expect(q.size).toBe(3);
    expect(q.peek()).toBe(1);
    expect(q.dequeue()).toBe(1);
    expect(q.dequeue()).toBe(2);
    expect(q.size).toBe(1);
    expect(q.dequeue()).toBe(3);
    expect(q.dequeue()).toBeUndefined();
    expect(q.isEmpty).toBe(true);
  });

  it('reject 策略：队满时 enqueue 返回 false 并保留旧元素', () => {
    const q = new BoundedQueue<number>({ capacity: 3, overflow: 'reject' });
    expect(q.enqueue(1)).toBe(true);
    expect(q.enqueue(2)).toBe(true);
    expect(q.enqueue(3)).toBe(true);
    expect(q.isFull).toBe(true);
    expect(q.enqueue(4)).toBe(false); // queue overflow
    expect(q.rejectCount).toBe(1);
    expect(q.toArray()).toEqual([1, 2, 3]);
  });

  it('overwrite_oldest 策略：队满时丢弃最旧元素', () => {
    const q = new BoundedQueue<number>({ capacity: 3, overflow: 'overwrite_oldest' });
    q.enqueue(1); q.enqueue(2); q.enqueue(3);
    expect(q.enqueue(4)).toBe(true); // 丢弃 1
    expect(q.evictionCount).toBe(1);
    expect(q.toArray()).toEqual([2, 3, 4]);
    expect(q.size).toBe(3);
    expect(q.dequeue()).toBe(2);
  });

  it('ring buffer 环绕：反复 enqueue/dequeue 后顺序仍正确', () => {
    const q = new BoundedQueue<number>({ capacity: 3 });
    q.enqueue(1); q.enqueue(2);
    expect(q.dequeue()).toBe(1);
    q.enqueue(3); q.enqueue(4); // tail 环绕
    expect(q.toArray()).toEqual([2, 3, 4]);
    expect(q.dequeue()).toBe(2);
    expect(q.dequeue()).toBe(3);
    expect(q.dequeue()).toBe(4);
  });

  it('size 与 capacity 不变式：size 永不超过 capacity', () => {
    const q = new BoundedQueue<number>({ capacity: 5, overflow: 'overwrite_oldest' });
    for (let i = 0; i < 10000; i++) q.enqueue(i);
    expect(q.size).toBeLessThanOrEqual(q.capacity);
    expect(q.size).toBe(5);
    expect(q.loadFactor).toBe(1);
    expect(q.toArray()).toEqual([9995, 9996, 9997, 9998, 9999]);
  });

  it('capacity=0 时所有 enqueue 被拒绝', () => {
    const q = new BoundedQueue<number>({ capacity: 0 });
    expect(q.enqueue(1)).toBe(false);
    expect(q.rejectCount).toBe(1);
    expect(q.size).toBe(0);
  });

  it('clear 重置队列', () => {
    const q = new BoundedQueue<number>({ capacity: 3 });
    q.enqueue(1); q.enqueue(2);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.dequeue()).toBeUndefined();
    expect(q.enqueue(9)).toBe(true);
    expect(q.peek()).toBe(9);
  });

  it('stats 字段完整（队列以单 bucket 语义暴露）', () => {
    const q = new BoundedQueue<number>({ capacity: 8 });
    q.enqueue(1);
    expect(q.stats()).toMatchObject({
      size: 1,
      capacity: 8,
      bucketCount: 1,
      bucketCapacity: 8,
      rejectCount: 0,
      evictionCount: 0,
    });
  });

  it('estimateBoundedQueueBytes 单调且为正', () => {
    const a = estimateBoundedQueueBytes(100, 128);
    const b = estimateBoundedQueueBytes(200, 128);
    expect(a).toBe(100 * (8 + 128));
    expect(b).toBeGreaterThan(a);
  });
});
