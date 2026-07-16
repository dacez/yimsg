import { describe, it, expect } from 'vitest';
import { FifoU64Map, estimateFifoU64MapBytes } from '../../../src/internal/bounded';

describe('FifoU64Map 基本读写', () => {
  it('set/get/has/delete 与 size', () => {
    const m = new FifoU64Map<string>({ capacity: 64 });
    expect(m.set('1', 'a')).toBe(true);
    expect(m.set('2', 'b')).toBe(true);
    expect(m.size).toBe(2);
    expect(m.get('1')).toBe('a');
    expect(m.has('2')).toBe(true);
    expect(m.has('3')).toBe(false);
    expect(m.get('3')).toBeUndefined();
    expect(m.delete('1')).toBe(true);
    expect(m.size).toBe(1);
    expect(m.get('1')).toBeUndefined();
    expect(m.delete('1')).toBe(false); // 重复删除返回 false
  });

  it('key="0" 是合法 key', () => {
    const m = new FifoU64Map<string>({ capacity: 16 });
    expect(m.set('0', 'zero')).toBe(true);
    expect(m.has('0')).toBe(true);
    expect(m.get('0')).toBe('zero');
  });

  it('更新已存在 key 不增加 size，且值被覆盖', () => {
    const m = new FifoU64Map<number>({ capacity: 8 });
    m.set('1', 1);
    m.set('2', 2);
    expect(m.size).toBe(2);
    m.set('1', 100);
    expect(m.size).toBe(2);
    expect(m.get('1')).toBe(100);
  });

  it('更新已存在 key 不重置其 FIFO 顺序（不会被当作"最新插入"）', () => {
    const m = new FifoU64Map<number>({ capacity: 3 });
    m.set('1', 1); // 插入顺序 1
    m.set('2', 2); // 插入顺序 2
    m.set('3', 3); // 插入顺序 3
    m.set('1', 111); // 更新已存在 key，不改变其插入顺序位置
    m.set('4', 4); // 容量满，应淘汰最早插入的 '1'（而非因为被更新过就被保留）
    expect(m.has('1')).toBe(false);
    expect(m.has('2')).toBe(true);
    expect(m.has('3')).toBe(true);
    expect(m.has('4')).toBe(true);
    expect(m.evictionCount).toBe(1);
  });
});

describe('FifoU64Map key 规范化', () => {
  it('十进制字符串的前导零与不带前导零视为同一 key', () => {
    const m = new FifoU64Map<string>({ capacity: 8 });
    m.set('007', 'a');
    expect(m.size).toBe(1);
    expect(m.get('7')).toBe('a');
    m.set('7', 'b');
    expect(m.size).toBe(1); // 未新增 key，只是更新
    expect(m.get('007')).toBe('b');
  });

  it('非法 uint64 字符串抛 RangeError：负数、小数、空串、非数字、越界', () => {
    const m = new FifoU64Map<string>({ capacity: 8 });
    for (const bad of ['', '-1', '1.5', 'abc', 'u:123', '12 ', ' 12', '18446744073709551616']) {
      expect(() => m.set(bad, 'x')).toThrow(RangeError);
      expect(() => m.get(bad)).toThrow(RangeError);
      expect(() => m.has(bad)).toThrow(RangeError);
      expect(() => m.delete(bad)).toThrow(RangeError);
    }
  });

  it('uint64 边界值（2^64-1）可正确存取', () => {
    const m = new FifoU64Map<string>({ capacity: 8 });
    const maxU64 = '18446744073709551615';
    m.set(maxU64, 'max');
    expect(m.get(maxU64)).toBe('max');
  });
});

describe('FifoU64Map 容量与 FIFO 淘汰', () => {
  it('容量为 0 时拒绝一切写入', () => {
    const m = new FifoU64Map<string>({ capacity: 0 });
    expect(m.set('1', 'a')).toBe(false);
    expect(m.size).toBe(0);
    expect(m.has('1')).toBe(false);
  });

  it('超出容量时淘汰最早插入的 key（严格 FIFO 顺序）', () => {
    const m = new FifoU64Map<number>({ capacity: 4 });
    for (let i = 0; i < 4; i++) m.set(String(i), i); // 0,1,2,3
    expect(m.set('4', 4)).toBe(true); // 淘汰最旧的 0
    expect(m.evictionCount).toBe(1);
    expect(m.size).toBe(4);
    expect(m.has('0')).toBe(false);
    expect(m.has('4')).toBe(true);
    expect(m.has('1')).toBe(true);

    expect(m.set('5', 5)).toBe(true); // 淘汰 1
    expect(m.has('1')).toBe(false);
    expect(m.has('2')).toBe(true);
    expect(m.evictionCount).toBe(2);
  });

  it('连续插入 capacity+N 个 key 后，只保留最后 capacity 个（严格顺序验证）', () => {
    const capacity = 10;
    const m = new FifoU64Map<number>({ capacity });
    const total = 37;
    for (let i = 0; i < total; i++) m.set(String(i), i);
    expect(m.size).toBe(capacity);
    expect(m.evictionCount).toBe(total - capacity);
    const expectedKeys = Array.from({ length: capacity }, (_, i) => String(total - capacity + i));
    expect(m.keys()).toEqual(expectedKeys);
    for (const k of expectedKeys) expect(m.has(k)).toBe(true);
  });

  it('size 不变式：大量随机 key 写入下 size 永不超过 capacity', () => {
    const m = new FifoU64Map<number>({ capacity: 32 });
    for (let i = 0; i < 100000; i++) {
      m.set(String(i % 500), i);
      expect(m.size).toBeLessThanOrEqual(m.capacity);
      expect(m.loadFactor).toBeLessThanOrEqual(1);
    }
  });

  it('capacity 非整数 / 负数在构造时被规范化（floor 且下限为 0）', () => {
    const m1 = new FifoU64Map<string>({ capacity: 4.9 });
    expect(m1.capacity).toBe(4);
    const m2 = new FifoU64Map<string>({ capacity: -5 });
    expect(m2.capacity).toBe(0);
  });
});

describe('FifoU64Map 遍历与清空', () => {
  it('forEach 与 keys 按 FIFO 插入顺序遍历', () => {
    const m = new FifoU64Map<number>({ capacity: 16 });
    m.set('30', 3);
    m.set('10', 1);
    m.set('20', 2);
    expect(m.keys()).toEqual(['30', '10', '20']);
    const seen: Array<[string, number]> = [];
    m.forEach((v, k) => seen.push([k, v]));
    expect(seen).toEqual([['30', 3], ['10', 1], ['20', 2]]);
  });

  it('clear 清空全部条目但保留累计 evictionCount', () => {
    const m = new FifoU64Map<number>({ capacity: 2 });
    m.set('1', 1);
    m.set('2', 2);
    m.set('3', 3); // 淘汰 '1'，evictionCount=1
    expect(m.evictionCount).toBe(1);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.keys()).toEqual([]);
    expect(m.get('2')).toBeUndefined();
    expect(m.evictionCount).toBe(1); // 累计计数不因 clear 重置
  });

  it('clear 之后可重新写满至 capacity', () => {
    const m = new FifoU64Map<number>({ capacity: 3 });
    m.set('1', 1); m.set('2', 2); m.set('3', 3); m.set('4', 4);
    m.clear();
    m.set('10', 10);
    m.set('20', 20);
    m.set('30', 30);
    expect(m.size).toBe(3);
    expect(m.set('40', 40)).toBe(true);
    expect(m.size).toBe(3);
    expect(m.has('10')).toBe(false);
  });
});

describe('FifoU64Map stats/loadFactor', () => {
  it('stats 字段完整且遵循非 bucket 结构统一约定（bucketCount=1, bucketCapacity=capacity, rejectCount=0）', () => {
    const m = new FifoU64Map<number>({ capacity: 10 });
    for (let i = 0; i < 5; i++) m.set(String(i), i);
    const s = m.stats();
    expect(s).toEqual({
      size: 5,
      capacity: 10,
      bucketCount: 1,
      bucketCapacity: 10,
      rejectCount: 0,
      evictionCount: 0,
      loadFactor: 0.5,
    });
  });

  it('loadFactor 在容量为 0 时恒为 0（避免除零 NaN）', () => {
    const m = new FifoU64Map<number>({ capacity: 0 });
    expect(m.loadFactor).toBe(0);
  });

  it('loadFactor 满载时为 1', () => {
    const m = new FifoU64Map<number>({ capacity: 4 });
    for (let i = 0; i < 4; i++) m.set(String(i), i);
    expect(m.loadFactor).toBe(1);
  });
});

describe('FifoU64Map 泛型值类型', () => {
  it('默认泛型参数为 string', () => {
    const m = new FifoU64Map({ capacity: 4 });
    m.set('1', 'hello');
    const v: string | undefined = m.get('1');
    expect(v).toBe('hello');
  });

  it('支持任意对象值类型（如带闭包字段的对象），泛型不限定为 string', () => {
    interface Entry { resolve: () => void; label: string }
    const m = new FifoU64Map<Entry>({ capacity: 4 });
    let called = false;
    const entry: Entry = { resolve: () => { called = true; }, label: 'x' };
    m.set('1', entry);
    expect(m.get('1')).toBe(entry);
    m.get('1')?.resolve();
    expect(called).toBe(true);
  });
});

describe('estimateFifoU64MapBytes', () => {
  it('随容量单调递增，容量为 0 时为 0', () => {
    expect(estimateFifoU64MapBytes(0, 640)).toBe(0);
    const small = estimateFifoU64MapBytes(100, 640);
    const big = estimateFifoU64MapBytes(200, 640);
    expect(small).toBeGreaterThan(0);
    expect(big).toBe(small * 2);
  });

  it('perValueBytes 为负数时按 0 处理，不产生负字节估算', () => {
    const withNegative = estimateFifoU64MapBytes(100, -640);
    const withZero = estimateFifoU64MapBytes(100, 0);
    expect(withNegative).toBe(withZero);
    expect(withNegative).toBeGreaterThan(0);
  });
});
