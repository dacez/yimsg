import { describe, expect, it, vi } from 'vitest';
import { invalidateAllBoundedLists, registerBoundedList, registeredBoundedListIds, unregisterBoundedList } from '../../../src/app/bounded-list/registry';

function fakeList(id: string) {
  return { id, invalidate: vi.fn() };
}

describe('BoundedList 注册表', () => {
  it('广播 invalidateAllBoundedLists 时通知全部已注册实例各一次', () => {
    const a = fakeList('registry.a');
    const b = fakeList('registry.b');
    registerBoundedList(a);
    registerBoundedList(b);
    try {
      invalidateAllBoundedLists();
      expect(a.invalidate).toHaveBeenCalledTimes(1);
      expect(b.invalidate).toHaveBeenCalledTimes(1);
    } finally {
      unregisterBoundedList(a);
      unregisterBoundedList(b);
    }
  });

  it('unregisterBoundedList 之后不再收到广播', () => {
    const a = fakeList('registry.c');
    registerBoundedList(a);
    unregisterBoundedList(a);
    invalidateAllBoundedLists();
    expect(a.invalidate).not.toHaveBeenCalled();
  });

  it('同 id 重复注册互相覆盖', () => {
    const first = fakeList('registry.dup');
    const second = fakeList('registry.dup');
    registerBoundedList(first);
    registerBoundedList(second);
    try {
      invalidateAllBoundedLists();
      expect(first.invalidate).not.toHaveBeenCalled();
      expect(second.invalidate).toHaveBeenCalledTimes(1);
    } finally {
      unregisterBoundedList(second);
    }
  });

  it('unregister 传入的实例若已被同 id 新实例覆盖，不会误删新实例', () => {
    const first = fakeList('registry.overwrite');
    const second = fakeList('registry.overwrite');
    registerBoundedList(first);
    registerBoundedList(second);
    unregisterBoundedList(first); // first 早已被覆盖，这里应是空操作
    expect(registeredBoundedListIds()).toContain('registry.overwrite');
    invalidateAllBoundedLists();
    expect(second.invalidate).toHaveBeenCalledTimes(1);
    unregisterBoundedList(second);
  });
});
