import { describe, it, expect } from 'vitest';
import { FifoMap } from '../../../src/internal/bounded';

describe('FifoMap 基本读写（string key）', () => {
  it('set/get/has/delete 与 size', () => {
    const m = new FifoMap<string, string>({ capacity: 64 });
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

  it('更新已存在 key 不增加 size，且值被覆盖', () => {
    const m = new FifoMap<string, number>({ capacity: 8 });
    m.set('1', 1);
    m.set('2', 2);
    expect(m.size).toBe(2);
    m.set('1', 100);
    expect(m.size).toBe(2);
    expect(m.get('1')).toBe(100);
  });

  it('更新已存在 key 不重置其 FIFO 顺序（不会被当作"最新插入"）', () => {
    const m = new FifoMap<string, number>({ capacity: 3 });
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

describe('FifoMap key 语义与原生 Map 完全一致', () => {
  it('数字 key（如 sqlite worker RPC id）按值比较', () => {
    const m = new FifoMap<number, string>({ capacity: 4 });
    m.set(1, 'a');
    m.set(2, 'b');
    expect(m.get(1)).toBe('a');
    expect(m.has(2)).toBe(true);
    expect(m.has(3)).toBe(false);
  });

  it('对象 key 按引用比较：不同实例即使内容相同也是不同 key', () => {
    interface K { id: number }
    const m = new FifoMap<K, string>({ capacity: 4 });
    const k1: K = { id: 1 };
    const k2: K = { id: 1 };
    m.set(k1, 'first');
    m.set(k2, 'second');
    expect(m.size).toBe(2);
    expect(m.get(k1)).toBe('first');
    expect(m.get(k2)).toBe('second');
    expect(m.has({ id: 1 })).toBe(false); // 第三个新对象，即便结构相同也不命中
  });

  it('NaN 作为 key 时按 SameValueZero 语义可正确存取（与原生 Map 一致）', () => {
    const m = new FifoMap<number, string>({ capacity: 4 });
    m.set(NaN, 'nan-value');
    expect(m.has(NaN)).toBe(true);
    expect(m.get(NaN)).toBe('nan-value');
  });

  it('值可以是任意对象类型（如带闭包字段的对象），不限定为 string', () => {
    interface Entry { resolve: () => void; label: string }
    const m = new FifoMap<string, Entry>({ capacity: 4 });
    let called = false;
    const entry: Entry = { resolve: () => { called = true; }, label: 'x' };
    m.set('1', entry);
    expect(m.get('1')).toBe(entry);
    m.get('1')?.resolve();
    expect(called).toBe(true);
  });
});

describe('FifoMap 容量与 FIFO 淘汰', () => {
  it('容量为 0 时拒绝一切写入', () => {
    const m = new FifoMap<string, string>({ capacity: 0 });
    expect(m.set('1', 'a')).toBe(false);
    expect(m.size).toBe(0);
    expect(m.has('1')).toBe(false);
  });

  it('超出容量时淘汰最早插入的 key（严格 FIFO 顺序）', () => {
    const m = new FifoMap<string, number>({ capacity: 4 });
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
    const m = new FifoMap<string, number>({ capacity });
    const total = 37;
    for (let i = 0; i < total; i++) m.set(String(i), i);
    expect(m.size).toBe(capacity);
    expect(m.evictionCount).toBe(total - capacity);
    const expectedKeys = Array.from({ length: capacity }, (_, i) => String(total - capacity + i));
    expect(m.keys()).toEqual(expectedKeys);
    for (const k of expectedKeys) expect(m.has(k)).toBe(true);
  });

  it('size 不变式：大量随机 key 写入下 size 永不超过 capacity', () => {
    const m = new FifoMap<string, number>({ capacity: 32 });
    for (let i = 0; i < 100000; i++) {
      m.set(String(i % 500), i);
      expect(m.size).toBeLessThanOrEqual(m.capacity);
      expect(m.loadFactor).toBeLessThanOrEqual(1);
    }
  });

  it('capacity 非整数 / 负数在构造时被规范化（floor 且下限为 0）', () => {
    const m1 = new FifoMap<string, string>({ capacity: 4.9 });
    expect(m1.capacity).toBe(4);
    const m2 = new FifoMap<string, string>({ capacity: -5 });
    expect(m2.capacity).toBe(0);
  });
});

describe('FifoMap 遍历与清空', () => {
  it('forEach / keys / values / entries 按 FIFO 插入顺序遍历', () => {
    const m = new FifoMap<string, number>({ capacity: 16 });
    m.set('30', 3);
    m.set('10', 1);
    m.set('20', 2);
    expect(m.keys()).toEqual(['30', '10', '20']);
    expect(m.values()).toEqual([3, 1, 2]);
    expect(m.entries()).toEqual([['30', 3], ['10', 1], ['20', 2]]);
    const seen: Array<[string, number]> = [];
    m.forEach((v, k) => seen.push([k, v]));
    expect(seen).toEqual([['30', 3], ['10', 1], ['20', 2]]);
  });

  it('clear 清空全部条目但保留累计 evictionCount', () => {
    const m = new FifoMap<string, number>({ capacity: 2 });
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
    const m = new FifoMap<string, number>({ capacity: 3 });
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

describe('FifoMap 与原生 Map 一致的迭代协议', () => {
  it('展开运算符 [...map] 按 FIFO 顺序产出 [key, value]', () => {
    const m = new FifoMap<string, number>({ capacity: 8 });
    m.set('a', 1);
    m.set('b', 2);
    expect([...m]).toEqual([['a', 1], ['b', 2]]);
  });

  it('for...of 可直接迭代', () => {
    const m = new FifoMap<string, number>({ capacity: 8 });
    m.set('a', 1);
    m.set('b', 2);
    const seen: Array<[string, number]> = [];
    for (const entry of m) seen.push(entry);
    expect(seen).toEqual([['a', 1], ['b', 2]]);
  });
});

describe('FifoMap stats/loadFactor', () => {
  it('stats 字段完整且遵循非 bucket 结构统一约定（bucketCount=1, bucketCapacity=capacity, rejectCount=0）', () => {
    const m = new FifoMap<string, number>({ capacity: 10 });
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
    const m = new FifoMap<string, number>({ capacity: 0 });
    expect(m.loadFactor).toBe(0);
  });

  it('loadFactor 满载时为 1', () => {
    const m = new FifoMap<string, number>({ capacity: 4 });
    for (let i = 0; i < 4; i++) m.set(String(i), i);
    expect(m.loadFactor).toBe(1);
  });
});
