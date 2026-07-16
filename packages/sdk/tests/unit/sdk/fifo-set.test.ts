import { describe, it, expect } from 'vitest';
import { FifoSet } from '../../../src/internal/bounded';

describe('FifoSet 基本读写（string 元素）', () => {
  it('add 幂等、has、delete、size', () => {
    const s = new FifoSet<string>({ capacity: 16 });
    expect(s.add('100')).toBe(true);
    expect(s.add('100')).toBe(true); // 幂等
    expect(s.size).toBe(1);
    expect(s.add('200')).toBe(true);
    expect(s.has('100')).toBe(true);
    expect(s.has('300')).toBe(false);
    expect(s.delete('100')).toBe(true);
    expect(s.size).toBe(1);
    expect(s.delete('100')).toBe(false); // 重复删除返回 false
  });

  it('drain 原子取出全部元素并清空（FIFO 顺序）', () => {
    const s = new FifoSet<string>({ capacity: 16 });
    s.add('100');
    s.add('200');
    s.add('300');
    const drained = s.drain();
    expect(drained).toEqual(['100', '200', '300']);
    expect(s.size).toBe(0);
    expect(s.has('100')).toBe(false);
  });

  it('add 已存在元素不重置其 FIFO 顺序', () => {
    const s = new FifoSet<string>({ capacity: 3 });
    s.add('1');
    s.add('2');
    s.add('3');
    s.add('1'); // 幂等，不改变插入顺序位置
    s.add('4'); // 容量满，应淘汰最早插入的 '1'
    expect(s.has('1')).toBe(false);
    expect(s.has('2')).toBe(true);
    expect(s.has('4')).toBe(true);
    expect(s.evictionCount).toBe(1);
  });
});

describe('FifoSet 元素语义与原生 Set 完全一致', () => {
  it('数字元素按值比较', () => {
    const s = new FifoSet<number>({ capacity: 4 });
    s.add(1);
    s.add(2);
    expect(s.has(1)).toBe(true);
    expect(s.has(3)).toBe(false);
  });

  it('对象元素按引用比较：不同实例即使内容相同也是不同元素', () => {
    interface E { id: number }
    const s = new FifoSet<E>({ capacity: 4 });
    const e1: E = { id: 1 };
    const e2: E = { id: 1 };
    s.add(e1);
    s.add(e2);
    expect(s.size).toBe(2);
    expect(s.has(e1)).toBe(true);
    expect(s.has(e2)).toBe(true);
    expect(s.has({ id: 1 })).toBe(false);
  });

  it('NaN 元素按 SameValueZero 语义可正确存取（与原生 Set 一致）', () => {
    const s = new FifoSet<number>({ capacity: 4 });
    s.add(NaN);
    expect(s.has(NaN)).toBe(true);
  });
});

describe('FifoSet 容量与 FIFO 淘汰', () => {
  it('容量为 0 时拒绝一切写入', () => {
    const s = new FifoSet<string>({ capacity: 0 });
    expect(s.add('1')).toBe(false);
    expect(s.size).toBe(0);
    expect(s.has('1')).toBe(false);
  });

  it('超出容量时淘汰最早插入的元素（严格 FIFO 顺序）', () => {
    const s = new FifoSet<string>({ capacity: 4 });
    for (let i = 0; i < 4; i++) s.add(String(i)); // 0,1,2,3
    expect(s.add('4')).toBe(true); // 淘汰最旧的 0
    expect(s.evictionCount).toBe(1);
    expect(s.size).toBe(4);
    expect(s.has('0')).toBe(false);
    expect(s.has('4')).toBe(true);
    expect(s.has('1')).toBe(true);

    expect(s.add('5')).toBe(true); // 淘汰 1
    expect(s.has('1')).toBe(false);
    expect(s.has('2')).toBe(true);
    expect(s.evictionCount).toBe(2);
  });

  it('连续插入 capacity+N 个元素后，只保留最后 capacity 个（严格顺序验证）', () => {
    const capacity = 10;
    const s = new FifoSet<string>({ capacity });
    const total = 37;
    for (let i = 0; i < total; i++) s.add(String(i));
    expect(s.size).toBe(capacity);
    expect(s.evictionCount).toBe(total - capacity);
    const expected = Array.from({ length: capacity }, (_, i) => String(total - capacity + i));
    expect(s.values()).toEqual(expected);
  });

  it('size 不变式：大量随机元素写入下 size 永不超过 capacity', () => {
    const s = new FifoSet<string>({ capacity: 32 });
    for (let i = 0; i < 100000; i++) {
      s.add(String(i % 500));
      expect(s.size).toBeLessThanOrEqual(s.capacity);
      expect(s.loadFactor).toBeLessThanOrEqual(1);
    }
  });

  it('capacity 非整数 / 负数在构造时被规范化（floor 且下限为 0）', () => {
    const s1 = new FifoSet<string>({ capacity: 4.9 });
    expect(s1.capacity).toBe(4);
    const s2 = new FifoSet<string>({ capacity: -5 });
    expect(s2.capacity).toBe(0);
  });
});

describe('FifoSet 遍历与清空', () => {
  it('forEach / values 按 FIFO 插入顺序遍历', () => {
    const s = new FifoSet<string>({ capacity: 16 });
    s.add('30');
    s.add('10');
    s.add('20');
    expect(s.values()).toEqual(['30', '10', '20']);
    const seen: string[] = [];
    s.forEach((v) => seen.push(v));
    expect(seen).toEqual(['30', '10', '20']);
  });

  it('clear 清空全部元素但保留累计 evictionCount', () => {
    const s = new FifoSet<string>({ capacity: 2 });
    s.add('1');
    s.add('2');
    s.add('3'); // 淘汰 '1'，evictionCount=1
    expect(s.evictionCount).toBe(1);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.values()).toEqual([]);
    expect(s.evictionCount).toBe(1); // 累计计数不因 clear 重置
  });

  it('clear 之后可重新写满至 capacity', () => {
    const s = new FifoSet<string>({ capacity: 3 });
    s.add('1'); s.add('2'); s.add('3'); s.add('4');
    s.clear();
    s.add('10');
    s.add('20');
    s.add('30');
    expect(s.size).toBe(3);
    expect(s.add('40')).toBe(true);
    expect(s.size).toBe(3);
    expect(s.has('10')).toBe(false);
  });
});

describe('FifoSet 与原生 Set 一致的迭代协议', () => {
  it('展开运算符 [...set] 按 FIFO 顺序产出元素', () => {
    const s = new FifoSet<string>({ capacity: 8 });
    s.add('a');
    s.add('b');
    expect([...s]).toEqual(['a', 'b']);
  });

  it('for...of 可直接迭代', () => {
    const s = new FifoSet<string>({ capacity: 8 });
    s.add('a');
    s.add('b');
    const seen: string[] = [];
    for (const v of s) seen.push(v);
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('FifoSet stats/loadFactor', () => {
  it('stats 字段完整且遵循非 bucket 结构统一约定（bucketCount=1, bucketCapacity=capacity, rejectCount=0）', () => {
    const s = new FifoSet<string>({ capacity: 10 });
    for (let i = 0; i < 5; i++) s.add(String(i));
    const stats = s.stats();
    expect(stats).toEqual({
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
    const s = new FifoSet<string>({ capacity: 0 });
    expect(s.loadFactor).toBe(0);
  });

  it('loadFactor 满载时为 1', () => {
    const s = new FifoSet<string>({ capacity: 4 });
    for (let i = 0; i < 4; i++) s.add(String(i));
    expect(s.loadFactor).toBe(1);
  });
});
