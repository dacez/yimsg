// 辅助模块单测：deep-equal（结构比较）、frame（帧调度）、registry（宿主注册契约）。
// 覆盖口径见 packages/uikit/docs/boundedlist/测试方案.md §4.6。

import { describe, expect, it, vi } from 'vitest';
import { valuesEquivalent } from '../../../src/app/bounded-list/deep-equal';
import { frameScheduler, nextFrame } from '../../../src/app/bounded-list/frame';
import { standaloneList } from '../../../src/app/bounded-list/registry';

describe('deep-equal', () => {
  it('原始值与同构对象判等，键顺序不影响结果', () => {
    expect(valuesEquivalent(1, 1)).toBe(true);
    expect(valuesEquivalent('a', 'b')).toBe(false);
    expect(valuesEquivalent(undefined, undefined)).toBe(true);
    // 键序不同不能判成「查询条件变了」，否则空态会误显示成「无搜索结果」。
    expect(valuesEquivalent({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valuesEquivalent({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('数组按元素比较，长度不同判不等', () => {
    expect(valuesEquivalent([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(valuesEquivalent([1, 2], [1, 2, 3])).toBe(false);
  });

  it('Date 与 TypedArray 按值比较', () => {
    expect(valuesEquivalent(new Date(1000), new Date(1000))).toBe(true);
    expect(valuesEquivalent(new Date(1000), new Date(2000))).toBe(false);
    expect(valuesEquivalent(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(valuesEquivalent(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(valuesEquivalent(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('环引用不会无限递归', () => {
    const left: Record<string, unknown> = { name: 'x' };
    const right: Record<string, unknown> = { name: 'x' };
    left.self = left;
    right.self = right;
    expect(valuesEquivalent(left, right)).toBe(true);
  });

  it('原型不同直接判不等（不把 class 实例当普通对象逐键比）', () => {
    class Box { constructor(public value = 1) {} }
    expect(valuesEquivalent(new Box(), { value: 1 })).toBe(false);
  });

  it('深度超过上限时向「不等」方向退化', () => {
    const deep = (depth: number): unknown => (depth === 0 ? 1 : { next: deep(depth - 1) });
    expect(valuesEquivalent(deep(12), deep(12))).toBe(false);
  });
});

describe('frameScheduler', () => {
  it('没有 requestAnimationFrame 时按 fallback 执行：sync 立即跑，microtask 延后', async () => {
    const order: string[] = [];
    const sync = frameScheduler(() => order.push('sync'));
    const micro = frameScheduler(() => order.push('micro'), 'microtask');
    sync();
    micro();
    order.push('caller');
    await Promise.resolve();
    expect(order).toEqual(['sync', 'caller', 'micro']);
  });

  it('有 requestAnimationFrame 时同帧合并，cancel 之后已排队的回调也不再执行', () => {
    const queue: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(() => cb(0));
      return queue.length;
    });
    try {
      const run = vi.fn();
      const schedule = frameScheduler(run);
      schedule();
      schedule();
      schedule();
      expect(queue).toHaveLength(1);
      schedule.cancel();
      queue.splice(0).forEach((cb) => cb());
      expect(run).not.toHaveBeenCalled();

      schedule();
      queue.splice(0).forEach((cb) => cb());
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('nextFrame 在没有 requestAnimationFrame 时同步执行', () => {
    const run = vi.fn();
    nextFrame(run);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('registry', () => {
  it('standaloneList 返回空操作的注销函数，代表「不接入宿主广播」', () => {
    const unregister = standaloneList({ id: 'x', invalidate: () => {} });
    expect(typeof unregister).toBe('function');
    expect(() => unregister()).not.toThrow();
  });
});
