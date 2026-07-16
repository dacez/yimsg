import { describe, it, expect } from 'vitest';
import { computeBoundedCapacity } from '../../../src/internal/bounded/bucket-layout';
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

  it('computeBoundedCapacity 向上对齐到 bucketCount(2^n) * bucketCapacity', () => {
    expect(computeBoundedCapacity(100, 8).capacity).toBe(128);
    expect(computeBoundedCapacity(0, 8).capacity).toBe(0);
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
