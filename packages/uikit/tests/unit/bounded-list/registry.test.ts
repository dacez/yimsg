// BoundedList 注册表单测。
// 分类见 packages/uikit/docs/BoundedList测试方案.md §4.4：A 注册与注销 / B 广播 / C 边界。

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateAllBoundedLists,
  registerBoundedList,
  registeredBoundedListIds,
  unregisterBoundedList,
  type Invalidatable,
} from '../../../src/app/bounded-list/registry';

function fakeList(id: string): Invalidatable & { invalidate: ReturnType<typeof vi.fn> } {
  return { id, invalidate: vi.fn() };
}

const created: Invalidatable[] = [];
function track<T extends Invalidatable>(instance: T): T {
  created.push(instance);
  return instance;
}

afterEach(() => {
  // 注册表是模块级单例，用例之间必须彻底清干净，否则会互相污染广播断言。
  for (const instance of created.splice(0)) unregisterBoundedList(instance);
});

// ───────────────────────── A 注册与注销 ─────────────────────────

describe('BoundedList 注册表 / A 注册与注销', () => {
  it('A1 注册后出现在 registeredBoundedListIds，注销后消失', () => {
    const a = track(fakeList('registry.a'));
    expect(registeredBoundedListIds()).not.toContain('registry.a');
    registerBoundedList(a);
    expect(registeredBoundedListIds()).toContain('registry.a');
    unregisterBoundedList(a);
    expect(registeredBoundedListIds()).not.toContain('registry.a');
  });

  it('A2 unregisterBoundedList 之后不再收到广播', () => {
    const a = track(fakeList('registry.c'));
    registerBoundedList(a);
    unregisterBoundedList(a);
    invalidateAllBoundedLists();
    expect(a.invalidate).not.toHaveBeenCalled();
  });

  it('A3 未注册过的实例执行 unregister 是空操作', () => {
    const stranger = fakeList('registry.never-registered');
    expect(() => unregisterBoundedList(stranger)).not.toThrow();
    expect(registeredBoundedListIds()).not.toContain('registry.never-registered');
  });

  it('A4 重复注册同一实例只占一个位置（Map 按 id 收敛）', () => {
    const a = track(fakeList('registry.same'));
    registerBoundedList(a);
    registerBoundedList(a);
    expect(registeredBoundedListIds().filter((id) => id === 'registry.same')).toHaveLength(1);
    invalidateAllBoundedLists();
    expect(a.invalidate).toHaveBeenCalledTimes(1);
  });

  it('A5 registeredBoundedListIds 返回的是快照，改它不影响注册表', () => {
    const a = track(fakeList('registry.snapshot'));
    registerBoundedList(a);
    const ids = registeredBoundedListIds();
    ids.push('伪造的 id');
    expect(registeredBoundedListIds()).not.toContain('伪造的 id');
  });
});

// ───────────────────────── B 广播 ─────────────────────────

describe('BoundedList 注册表 / B 广播', () => {
  it('B1 广播 invalidateAllBoundedLists 时通知全部已注册实例各一次', () => {
    const a = track(fakeList('registry.b1'));
    const b = track(fakeList('registry.b2'));
    registerBoundedList(a);
    registerBoundedList(b);
    invalidateAllBoundedLists();
    expect(a.invalidate).toHaveBeenCalledTimes(1);
    expect(b.invalidate).toHaveBeenCalledTimes(1);
    expect(a.invalidate).toHaveBeenCalledWith(); // 广播不带任何参数
  });

  it('B2 invalidate 返回 Promise 时按 fire-and-forget 处理，广播本身同步返回', async () => {
    let settled = false;
    const asyncList = track({
      id: 'registry.async',
      invalidate: () => new Promise<void>((resolve) => setTimeout(() => { settled = true; resolve(); }, 0)),
    });
    registerBoundedList(asyncList);
    invalidateAllBoundedLists();
    expect(settled).toBe(false); // 没有被 await
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(settled).toBe(true);
    // 注意：广播用 `void instance.invalidate()` 丢弃返回值，异步实现一旦拒绝就会变成
    // 未处理拒绝（见 BL-BUG-23）；当前仓库里的 BoundedList.invalidate 是同步 void，
    // 因此这条风险还没有被真实触发。
  });

  it('B3 空注册表广播是空操作', () => {
    expect(registeredBoundedListIds()).toHaveLength(0);
    expect(() => invalidateAllBoundedLists()).not.toThrow();
  });

  it('B4 200 个实例的广播全部命中（重连后一次性追平全部列表）', () => {
    const lists = Array.from({ length: 200 }, (_, i) => track(fakeList(`registry.bulk-${i}`)));
    for (const l of lists) registerBoundedList(l);
    invalidateAllBoundedLists();
    for (const l of lists) expect(l.invalidate).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── C 边界 ─────────────────────────

describe('BoundedList 注册表 / C 边界', () => {
  it('C1 同 id 重复注册互相覆盖', () => {
    const first = track(fakeList('registry.dup'));
    const second = track(fakeList('registry.dup'));
    registerBoundedList(first);
    registerBoundedList(second);
    invalidateAllBoundedLists();
    expect(first.invalidate).not.toHaveBeenCalled();
    expect(second.invalidate).toHaveBeenCalledTimes(1);
  });

  it('C2 unregister 传入的实例若已被同 id 新实例覆盖，不会误删新实例', () => {
    const first = track(fakeList('registry.overwrite'));
    const second = track(fakeList('registry.overwrite'));
    registerBoundedList(first);
    registerBoundedList(second);
    unregisterBoundedList(first); // first 早已被覆盖，这里应是空操作
    expect(registeredBoundedListIds()).toContain('registry.overwrite');
    invalidateAllBoundedLists();
    expect(second.invalidate).toHaveBeenCalledTimes(1);
  });

  it('C3 广播过程中被 invalidate 回调注销自己不会抛错', () => {
    const a: Invalidatable & { invalidate: ReturnType<typeof vi.fn> } = fakeList('registry.self-remove');
    a.invalidate.mockImplementation(() => unregisterBoundedList(a));
    const b = track(fakeList('registry.after-self-remove'));
    registerBoundedList(a);
    registerBoundedList(b);
    expect(() => invalidateAllBoundedLists()).not.toThrow();
    expect(b.invalidate).toHaveBeenCalledTimes(1);
    expect(registeredBoundedListIds()).not.toContain('registry.self-remove');
  });

  it('C4 空 id 也是合法 key（组件不校验 id，注册表按原样收敛）', () => {
    const anonymous = track(fakeList(''));
    registerBoundedList(anonymous);
    expect(registeredBoundedListIds()).toContain('');
    invalidateAllBoundedLists();
    expect(anonymous.invalidate).toHaveBeenCalledTimes(1);
  });
});
