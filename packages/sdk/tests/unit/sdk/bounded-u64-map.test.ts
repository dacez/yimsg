import { describe, it, expect } from 'vitest';
import {
  BoundedU64Map,
  computeBoundedCapacity,
  estimateBoundedU64MapBytes,
} from '../../../src/internal/bounded/bounded-u64-map';
import { BoundedU64Set as BoundedU64SetClass } from '../../../src/internal/bounded/bounded-u64-set';
import { BoundedU64Set } from '../../../src/internal/bounded';
import { parseU64, u64FromNumber, u64ToString, hashU64, nextPow2 } from '../../../src/internal/bounded/u64';

describe('u64 key helpers', () => {
  it('hi/lo 拆分与还原对大于 2^53 的 uint64 无损', () => {
    const big = '18446744073709551615'; // 2^64 - 1
    const k = parseU64(big);
    expect(k.hi).toBe(0xffffffff);
    expect(k.lo).toBe(0xffffffff);
    expect(u64ToString(k.hi, k.lo)).toBe(big);
  });

  it('普通十进制字符串往返一致', () => {
    for (const s of ['0', '1', '255', '4294967296', '1234567890123456789']) {
      const k = parseU64(s);
      expect(u64ToString(k.hi, k.lo)).toBe(s);
    }
  });

  it('非法 uint64 字符串抛 RangeError', () => {
    for (const bad of ['', '-1', '1.5', 'abc', 'u:123', '12 ']) {
      expect(() => parseU64(bad)).toThrow(RangeError);
    }
  });

  it('hi/lo 相等性：相同十进制串解析出的 key 命中同一条目', () => {
    const m = new BoundedU64Map<number>({ capacity: 64, eviction: 'fifo' });
    m.set('1234567890123456789', 42);
    const k = parseU64('1234567890123456789');
    expect(m.getKey(k.hi, k.lo)).toBe(42);
    expect(m.get('1234567890123456789')).toBe(42);
  });

  it('hashU64 输出 32 位无符号整数且对顺序整数有扩散', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const h = hashU64(0, i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      seen.add(h & 15);
    }
    // 顺序整数低位经过混合后应覆盖全部 16 个 bucket（扩散性）
    expect(seen.size).toBe(16);
  });

  it('u64FromNumber 拆分 number 与字符串解析一致', () => {
    for (const n of [0, 1, 255, 4294967296, 4294967297]) {
      const a = u64FromNumber(n);
      const b = parseU64(String(n));
      expect(a).toEqual(b);
      expect(u64ToString(a.hi, a.lo)).toBe(String(n));
    }
    expect(() => u64FromNumber(-1)).toThrow(RangeError);
    expect(() => u64FromNumber(1.5)).toThrow(RangeError);
  });

  it('nextPow2 行为正确', () => {
    expect(nextPow2(0)).toBe(1);
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(8)).toBe(8);
    expect(nextPow2(9)).toBe(16);
  });
});

describe('BoundedU64Map', () => {
  it('容量向上对齐到 bucketCount(2^n) * bucketCapacity', () => {
    const m = new BoundedU64Map<number>({ capacity: 100, bucketCapacity: 8 });
    // ceil(100/8)=13 -> nextPow2=16 buckets -> 128 容量
    expect(m.bucketCount).toBe(16);
    expect(m.bucketCapacity).toBe(8);
    expect(m.capacity).toBe(128);
    expect(computeBoundedCapacity(100, 8).capacity).toBe(128);
  });

  it('基本 set/get/has/delete 与 size', () => {
    const m = new BoundedU64Map<string>({ capacity: 64 });
    expect(m.setKey(0, 1, 'a')).toBe(true);
    expect(m.setKey(0, 2, 'b')).toBe(true);
    expect(m.size).toBe(2);
    expect(m.getKey(0, 1)).toBe('a');
    expect(m.hasKey(0, 2)).toBe(true);
    expect(m.hasKey(0, 3)).toBe(false);
    // 更新已存在 key 不改变 size
    expect(m.setKey(0, 1, 'a2')).toBe(true);
    expect(m.getKey(0, 1)).toBe('a2');
    expect(m.size).toBe(2);
    expect(m.deleteKey(0, 1)).toBe(true);
    expect(m.size).toBe(1);
    expect(m.getKey(0, 1)).toBeUndefined();
  });

  it('key=0 是合法 key（不与 EMPTY 槽位混淆）', () => {
    const m = new BoundedU64Map<string>({ capacity: 16 });
    expect(m.setKey(0, 0, 'zero')).toBe(true);
    expect(m.hasKey(0, 0)).toBe(true);
    expect(m.getKey(0, 0)).toBe('zero');
  });

  it('bucket hash 冲突：同 bucket 多个 key 通过桶内线性扫描共存', () => {
    // bucketCount=1 => 所有 key 落入同一 bucket，bucketCapacity=8
    const m = new BoundedU64Map<number>({ capacity: 8, bucketCapacity: 8 });
    expect(m.bucketCount).toBe(1);
    for (let i = 0; i < 8; i++) expect(m.setKey(0, i, i)).toBe(true);
    expect(m.size).toBe(8);
    for (let i = 0; i < 8; i++) expect(m.getKey(0, i)).toBe(i);
  });

  it('reject 策略：bucket 满后拒绝新 key 并累加 rejectCount', () => {
    const m = new BoundedU64Map<number>({ capacity: 4, bucketCapacity: 4, eviction: 'reject' });
    expect(m.bucketCount).toBe(1);
    for (let i = 0; i < 4; i++) expect(m.setKey(0, i, i)).toBe(true);
    expect(m.setKey(0, 99, 99)).toBe(false);
    expect(m.rejectCount).toBe(1);
    expect(m.size).toBe(4);
    expect(m.hasKey(0, 99)).toBe(false);
    // 已有 key 仍可更新
    expect(m.setKey(0, 0, 1000)).toBe(true);
    expect(m.getKey(0, 0)).toBe(1000);
  });

  it('fifo 策略：bucket 满后淘汰最早插入的 key', () => {
    const m = new BoundedU64Map<number>({ capacity: 4, bucketCapacity: 4, eviction: 'fifo' });
    for (let i = 0; i < 4; i++) m.setKey(0, i, i); // 插入 0,1,2,3
    expect(m.setKey(0, 4, 4)).toBe(true); // 淘汰最旧的 0
    expect(m.evictionCount).toBe(1);
    expect(m.size).toBe(4);
    expect(m.hasKey(0, 0)).toBe(false);
    expect(m.hasKey(0, 4)).toBe(true);
    expect(m.hasKey(0, 1)).toBe(true);
  });

  it('lru 策略：访问会刷新顺序，淘汰最久未访问的 key', () => {
    const m = new BoundedU64Map<number>({ capacity: 4, bucketCapacity: 4, eviction: 'lru' });
    for (let i = 0; i < 4; i++) m.setKey(0, i, i); // 0,1,2,3
    m.getKey(0, 0); // 访问 0，使其变为最近使用
    expect(m.setKey(0, 4, 4)).toBe(true); // 淘汰最久未访问的 1（而非 0）
    expect(m.hasKey(0, 0)).toBe(true);
    expect(m.hasKey(0, 1)).toBe(false);
    expect(m.evictionCount).toBe(1);
  });

  it('size 不变式：满载下 size 永不超过 capacity', () => {
    const m = new BoundedU64Map<number>({ capacity: 32, bucketCapacity: 8, eviction: 'fifo' });
    for (let i = 0; i < 100000; i++) m.setKey(i & 0xffff, i, i);
    expect(m.size).toBeLessThanOrEqual(m.capacity);
    expect(m.loadFactor).toBeLessThanOrEqual(1);
  });

  it('capacity 不变式：reject 策略下 size 永不超过 capacity', () => {
    const m = new BoundedU64Map<number>({ capacity: 16, bucketCapacity: 8, eviction: 'reject' });
    for (let i = 0; i < 100000; i++) m.setKey(i & 0xff, i, i);
    expect(m.size).toBeLessThanOrEqual(m.capacity);
  });

  it('max load test：填满每个 bucket 后 loadFactor=1', () => {
    const m = new BoundedU64Map<number>({ capacity: 8, bucketCapacity: 8 });
    // 单 bucket，填满 8 个槽
    for (let i = 0; i < 8; i++) m.setKey(0, i, i);
    expect(m.size).toBe(8);
    expect(m.loadFactor).toBe(1);
  });

  it('clear 重置占用但保留累计计数', () => {
    const m = new BoundedU64Map<number>({ capacity: 4, bucketCapacity: 4, eviction: 'reject' });
    for (let i = 0; i < 4; i++) m.setKey(0, i, i);
    m.setKey(0, 99, 99); // reject + rejectCount=1
    m.clear();
    expect(m.size).toBe(0);
    expect(m.rejectCount).toBe(1);
    expect(m.getKey(0, 0)).toBeUndefined();
  });

  it('forEach 与 keys 遍历全部占用槽', () => {
    const m = new BoundedU64Map<number>({ capacity: 16 });
    m.set('10', 1); m.set('20', 2); m.set('30', 3);
    const seen = new Set<string>();
    m.forEach((v, hi, lo) => { seen.add(u64ToString(hi, lo)); expect([1, 2, 3]).toContain(v); });
    expect(seen).toEqual(new Set(['10', '20', '30']));
    expect(new Set(m.keys())).toEqual(new Set(['10', '20', '30']));
  });

  it('stats 字段完整', () => {
    const m = new BoundedU64Map<number>({ capacity: 100, bucketCapacity: 8, eviction: 'fifo' });
    const s = m.stats();
    expect(s).toMatchObject({
      size: 0,
      capacity: 128,
      bucketCount: 16,
      bucketCapacity: 8,
      rejectCount: 0,
      evictionCount: 0,
      loadFactor: 0,
    });
  });

  it('estimateBoundedU64MapBytes 与实际容量一致且单调', () => {
    const small = estimateBoundedU64MapBytes(100, 640, 8, 'fifo');
    const big = estimateBoundedU64MapBytes(200, 640, 8, 'fifo');
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    // reject 策略无 seqs，单 slot 结构更小
    const reject = estimateBoundedU64MapBytes(100, 640, 8, 'reject');
    expect(reject).toBeLessThan(small);
  });
});

describe('BoundedU64Set', () => {
  it('add 幂等、has、delete、drain', () => {
    const s = new BoundedU64SetClass({ capacity: 16 });
    expect(s.add('100')).toBe(true);
    expect(s.add('100')).toBe(true); // 幂等
    expect(s.size).toBe(1);
    expect(s.add('200')).toBe(true);
    expect(s.has('100')).toBe(true);
    const drained = s.drain().sort();
    expect(drained).toEqual(['100', '200']);
    expect(s.size).toBe(0);
  });

  it('reject：容量满时 add 返回 false', () => {
    const s = new BoundedU64SetClass({ capacity: 4, bucketCapacity: 4 });
    for (let i = 0; i < 4; i++) expect(s.addKey(0, i)).toBe(true);
    expect(s.addKey(0, 99)).toBe(false);
    expect(s.rejectCount).toBe(1);
    expect(s.size).toBe(4);
  });

  it('re-export 的 BoundedU64Set 与直接 import 同源', () => {
    expect(BoundedU64Set).toBe(BoundedU64SetClass);
  });
});
