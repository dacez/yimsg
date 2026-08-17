// SelectionStore（选中态）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.3：
//   A 基础语义 / B 上限 / C 订阅通知 / D 边界与大规模。

import { describe, expect, it, vi } from 'vitest';
import { SelectionStore } from '../../../src/app/bounded-list/selection';

// ───────────────────────── A 基础语义 ─────────────────────────

describe('SelectionStore / A 基础语义', () => {
  it('A1 toggle 添加与移除，达上限且未选中时拒绝', () => {
    const store = new SelectionStore(2);
    expect(store.toggle('a')).toBe('added');
    expect(store.toggle('b')).toBe('added');
    expect(store.has('a')).toBe(true);
    expect(store.size).toBe(2);

    expect(store.toggle('c')).toBe('rejected');
    expect(store.has('c')).toBe(false);
    expect(store.size).toBe(2);

    expect(store.toggle('a')).toBe('removed');
    expect(store.size).toBe(1);
    expect(store.toggle('c')).toBe('added'); // 移除后腾出名额
  });

  it('A2 replaceSingle 替换为仅含该 id（单选语义）', () => {
    const store = new SelectionStore();
    store.toggle('a');
    store.toggle('b');
    store.replaceSingle('c');
    expect(store.snapshotIds()).toEqual(new Set(['c']));
    expect(store.size).toBe(1);
  });

  it('A3 replaceSingle 不受 max 限制（单选永远只有一个）', () => {
    const store = new SelectionStore(1);
    store.toggle('a');
    store.replaceSingle('b');
    expect(store.snapshotIds()).toEqual(new Set(['b']));
  });

  it('A4 snapshotIds 返回拷贝：改动快照不影响 store，store 变化也不回写快照', () => {
    const store = new SelectionStore();
    store.toggle('a');
    const snap = store.snapshotIds() as Set<string>;
    snap.add('hacked');
    expect(store.has('hacked')).toBe(false);
    store.toggle('b');
    expect(snap.has('b')).toBe(false);
  });

  it('A5 clear 清空并只在有内容时才通知订阅者', () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear(); // 本就为空，不通知
    expect(listener).not.toHaveBeenCalled();
    store.toggle('a');
    listener.mockClear();
    store.clear();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it('A8 delete 精确摘掉一个身份，只在确实删掉时通知；未命中返回 false', () => {
    const store = new SelectionStore();
    store.toggle('a');
    store.toggle('b');
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.delete('a')).toBe(true);
    expect(store.snapshotIds()).toEqual(new Set(['b']));
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    expect(store.delete('a')).toBe(false);
    expect(store.delete('不存在')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('A9 delete 只动指定身份，不影响其它实例共享进来的选中项', () => {
    const store = new SelectionStore();
    for (const id of ['u:1', 'u:2', 'g:9']) store.toggle(id);
    store.delete('u:2');
    expect(store.snapshotIds()).toEqual(new Set(['u:1', 'g:9']));
  });
});

// ───────────────────────── B 上限 ─────────────────────────

describe('SelectionStore / B 上限 max', () => {
  it('B1 isExceeded：已达上限且当前未选中时为 true，已选中或未设上限时为 false', () => {
    const store = new SelectionStore(1);
    store.toggle('a');
    expect(store.isExceeded('a')).toBe(false); // 已选中，不受禁用影响
    expect(store.isExceeded('b')).toBe(true);

    const unlimited = new SelectionStore();
    unlimited.toggle('x');
    expect(unlimited.isExceeded('y')).toBe(false);
  });

  it('B2 max=0：任何 id 都不可选，isExceeded 恒为 true', () => {
    const store = new SelectionStore(0);
    expect(store.toggle('a')).toBe('rejected');
    expect(store.isExceeded('a')).toBe(true);
    expect(store.size).toBe(0);
  });

  it('B3 max=1 时反复 toggle 同一个与不同 id：语义稳定', () => {
    const store = new SelectionStore(1);
    expect(store.toggle('a')).toBe('added');
    expect(store.toggle('b')).toBe('rejected');
    expect(store.toggle('a')).toBe('removed');
    expect(store.toggle('b')).toBe('added');
    expect(store.snapshotIds()).toEqual(new Set(['b']));
  });

  it('B4 被拒绝的 toggle 不通知订阅者（避免无意义重渲）', () => {
    const store = new SelectionStore(1);
    store.toggle('a');
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.toggle('b')).toBe('rejected');
    expect(listener).not.toHaveBeenCalled();
  });

  it('B5 达上限后 delete 腾出名额，新 id 又可以选中', () => {
    const store = new SelectionStore(2);
    store.toggle('a');
    store.toggle('b');
    expect(store.toggle('c')).toBe('rejected');
    store.delete('b');
    expect(store.toggle('c')).toBe('added');
  });
});

// ───────────────────────── C 订阅通知 ─────────────────────────

describe('SelectionStore / C 订阅通知', () => {
  it('C1 多个订阅者共享同一个 store：任一变化通知全部订阅者（转发弹窗双 tab 同步的基础）', () => {
    const store = new SelectionStore(500);
    const tabA = vi.fn();
    const tabB = vi.fn();
    store.subscribe(tabA);
    store.subscribe(tabB);
    store.toggle('u:1001:0:0');
    expect(tabA).toHaveBeenCalledTimes(1);
    expect(tabB).toHaveBeenCalledTimes(1);
  });

  it('C1b replaceSingle 选中的已经正是这一项时不通知（重复点同一行不该整表重绘）', () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    store.replaceSingle('a');
    store.subscribe(listener);
    store.replaceSingle('a');
    expect(listener).not.toHaveBeenCalled();
    store.replaceSingle('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('C1c 多选留下的多项被 replaceSingle 收敛成一项时照常通知', () => {
    // 「已选集合里含有该 id」不等于「已经正是这一项」，收敛掉其余项是真实变化。
    const store = new SelectionStore();
    store.toggle('a');
    store.toggle('b');
    const listener = vi.fn();
    store.subscribe(listener);
    store.replaceSingle('a');
    expect(listener).toHaveBeenCalledTimes(1);
    expect([...store.snapshotIds()]).toEqual(['a']);
  });

  it('C2 subscribe 返回的取消函数生效后不再收到通知，且可重复调用', () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    unsubscribe(); // 幂等
    store.toggle('a');
    expect(listener).not.toHaveBeenCalled();
  });

  it('C3 同一个函数重复 subscribe 只登记一份（listeners 是 Set）', () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.subscribe(listener);
    store.toggle('a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('C4 订阅者内部再改动 store 时不会死循环（自身守卫由调用方负责，这里只保证不崩）', () => {
    const store = new SelectionStore();
    let depth = 0;
    store.subscribe(() => {
      depth++;
      if (depth < 3) store.toggle(`nested-${depth}`);
    });
    expect(() => store.toggle('root')).not.toThrow();
    expect(store.size).toBe(3);
  });

  it('C5 订阅者在通知过程中取消自己的订阅不会抛错（Set 遍历安全）', () => {
    const store = new SelectionStore();
    const calls: string[] = [];
    const un = store.subscribe(() => { calls.push('self'); un(); });
    store.subscribe(() => calls.push('other'));
    expect(() => store.toggle('a')).not.toThrow();
    expect(calls).toEqual(['self', 'other']);
    calls.length = 0;
    store.toggle('b');
    expect(calls).toEqual(['other']);
  });

  it('C6 通知前先快照订阅者集合：本轮新增的订阅不会被本轮通知到', () => {
    const store = new SelectionStore();
    const late = vi.fn();
    store.subscribe(() => { store.subscribe(late); });
    store.toggle('a');
    expect(late).not.toHaveBeenCalled(); // 本轮不通知，下一轮才算数
    store.toggle('b');
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('C7 通知期间注销的订阅者仍会收到本轮通知（快照语义确定，不依赖遍历顺序）', () => {
    const store = new SelectionStore();
    const order: string[] = [];
    let unsubscribeSecond: (() => void) | null = null;
    store.subscribe(() => { order.push('first'); unsubscribeSecond?.(); });
    unsubscribeSecond = store.subscribe(() => order.push('second'));
    store.toggle('a');
    expect(order).toEqual(['first', 'second']);
    order.length = 0;
    store.toggle('b');
    expect(order).toEqual(['first']);
  });
});

// ───────────────────────── D 边界与大规模 ─────────────────────────

describe('SelectionStore / D 边界与大规模', () => {
  it('D1 空字符串 id 与超长 id 都按普通身份处理', () => {
    const store = new SelectionStore();
    const long = 'x'.repeat(10000);
    expect(store.toggle('')).toBe('added');
    expect(store.has('')).toBe(true);
    expect(store.toggle(long)).toBe('added');
    expect(store.has(long)).toBe(true);
    expect(store.size).toBe(2);
  });

  it('D2 转发上限 500 的真实规模：恰好选满 500 个，第 501 个被拒', () => {
    const store = new SelectionStore(500);
    for (let i = 0; i < 500; i++) expect(store.toggle(`u:${i}:0:0`)).toBe('added');
    expect(store.size).toBe(500);
    expect(store.toggle('u:500:0:0')).toBe('rejected');
    expect(store.isExceeded('u:500:0:0')).toBe(true);
    expect(store.isExceeded('u:499:0:0')).toBe(false);
  });

  it('D3 50000 个身份的 clear 一次清空，且只通知一次', () => {
    const store = new SelectionStore();
    for (let i = 0; i < 50000; i++) store.toggle(`id-${i}`);
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear();
    expect(store.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('D4 大量订阅者（模拟大量共享实例）时每次变化都全量通知', () => {
    const store = new SelectionStore();
    const listeners = Array.from({ length: 200 }, () => vi.fn());
    for (const l of listeners) store.subscribe(l);
    store.toggle('a');
    for (const l of listeners) expect(l).toHaveBeenCalledTimes(1);
  });
});
