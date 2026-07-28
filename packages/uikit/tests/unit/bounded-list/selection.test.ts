import { describe, expect, it, vi } from 'vitest';
import { SelectionStore } from '../../../src/app/bounded-list/selection';

describe('SelectionStore', () => {
  it('toggle 添加与移除，达上限且未选中时拒绝', () => {
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

  it('isExceeded：已达上限且当前未选中时为 true，已选中或未设上限时为 false', () => {
    const store = new SelectionStore(1);
    store.toggle('a');
    expect(store.isExceeded('a')).toBe(false); // 已选中，不受禁用影响
    expect(store.isExceeded('b')).toBe(true);

    const unlimited = new SelectionStore();
    unlimited.toggle('x');
    expect(unlimited.isExceeded('y')).toBe(false);
  });

  it('replaceSingle 替换为仅含该 id（单选语义）', () => {
    const store = new SelectionStore();
    store.toggle('a');
    store.replaceSingle('b');
    expect(store.snapshotIds()).toEqual(new Set(['b']));
  });

  it('clear 清空并只在有内容时才通知订阅者', () => {
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

  it('retainOnly 只保留仍存在的身份（列表变化后修剪已滚出窗口但仍标记选中的 id）', () => {
    const store = new SelectionStore();
    store.toggle('a');
    store.toggle('b');
    store.toggle('c');
    const listener = vi.fn();
    store.subscribe(listener);
    store.retainOnly(new Set(['a', 'c']));
    expect(store.snapshotIds()).toEqual(new Set(['a', 'c']));
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    store.retainOnly(new Set(['a', 'c', 'd'])); // 未发生实际删除，不通知
    expect(listener).not.toHaveBeenCalled();
  });

  it('多个订阅者共享同一个 store：任一变化通知全部订阅者（转发弹窗双 tab 同步的基础）', () => {
    const store = new SelectionStore(500);
    const tabA = vi.fn();
    const tabB = vi.fn();
    store.subscribe(tabA);
    store.subscribe(tabB);
    store.toggle('u:1001:0:0');
    expect(tabA).toHaveBeenCalledTimes(1);
    expect(tabB).toHaveBeenCalledTimes(1);
  });

  it('subscribe 返回的取消函数生效后不再收到通知', () => {
    const store = new SelectionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.toggle('a');
    expect(listener).not.toHaveBeenCalled();
  });
});
