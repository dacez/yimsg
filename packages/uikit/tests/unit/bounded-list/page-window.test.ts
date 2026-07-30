// PageWindow（数据窗口层）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.1：
//   A 基础记账 / B 整页裁剪 / C 跨页去重 / D 就地增删改 / E 实时并入 / F 大数据量与长序列。

import { describe, expect, it, vi } from 'vitest';
import { PageWindow } from '../../../src/app/bounded-list/page-window';
import type { PageLoadResult } from '../../../src/app/bounded-list/types';

function page(items: number[], startCursor: string, endCursor: string, hasMoreBackward: boolean, hasMoreForward: boolean, total?: number): PageLoadResult<number> {
  return { items, startCursor, endCursor, hasMoreBackward, hasMoreForward, total };
}

const asKey = (n: number): string => String(n);

// ───────────────────────── A 基础记账 ─────────────────────────

describe('PageWindow / A 基础记账', () => {
  it('A1 setInitial 放入首页并暴露边界游标、hasMore 与 total', () => {
    const window = new PageWindow<number>(2);
    expect(window.loaded).toBe(false);
    expect(window.total).toBe(-1);
    window.setInitial(page([1, 2], 's1', 'e1', false, true, 12));
    expect(window.loaded).toBe(true);
    expect(window.items).toEqual([1, 2]);
    expect(window.count).toBe(2);
    expect(window.total).toBe(12);
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.cursorFor('tail')).toBe('e1');
    expect(window.hasMoreHead).toBe(false);
    expect(window.hasMoreTail).toBe(true);
  });

  it('A2 空页 setInitial 不标记已加载，total 未提供时为 -1，游标退化为空串', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([], '', '', false, false));
    expect(window.loaded).toBe(false);
    expect(window.items).toEqual([]);
    expect(window.count).toBe(0);
    expect(window.total).toBe(-1);
    expect(window.cursorFor('head')).toBe('');
    expect(window.cursorFor('tail')).toBe('');
  });

  it('A3 空页 setInitial 仍然如实透传该页的 hasMore（服务端说还有就还有）', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([], 's', 'e', true, true));
    expect(window.loaded).toBe(false);
    expect(window.hasMoreHead).toBe(true);
    expect(window.hasMoreTail).toBe(true);
  });

  it('A4 setInitial 重复调用等价于整体重建（旧页与旧 total 一并丢弃）', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1, 2], 's1', 'e1', true, true, 99));
    window.appendTail(page([3, 4], 's2', 'e2', true, true));
    window.setInitial(page([7], 's7', 'e7', false, false));
    expect(window.items).toEqual([7]);
    expect(window.total).toBe(-1);
    expect(window.cursorFor('head')).toBe('s7');
    expect(window.cursorFor('tail')).toBe('e7');
  });

  it('A5 续翻页未带 total 时保留上一次已知的 total', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1], 's1', 'e1', false, true, 42));
    window.appendTail(page([2], 's2', 'e2', false, true));
    expect(window.total).toBe(42);
    window.prependHead(page([0], 's0', 'e0', false, true));
    expect(window.total).toBe(42);
    window.appendTail(page([3], 's3', 'e3', false, false, 7));
    expect(window.total).toBe(7);
  });

  it('A6 空页续翻不新增页，但 hasMore 按该页结果收敛，游标保持保留页边界', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1, 2], 's1', 'e1', true, true));
    window.appendTail(page([], 'sx', 'ex', true, false));
    expect(window.items).toEqual([1, 2]);
    expect(window.cursorFor('tail')).toBe('e1');
    expect(window.hasMoreTail).toBe(false);
    window.prependHead(page([], 'sy', 'ey', false, false));
    expect(window.items).toEqual([1, 2]);
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.hasMoreHead).toBe(false);
  });

  it('A11 续翻拿到空页时强制收敛该端 hasMore（服务端违反契约也不会无限补页）', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1, 2], 's1', 'e1', true, true));
    // 服务端违反契约：空页却仍然报「还有更多」。
    window.appendTail(page([], 'sx', 'ex', true, true));
    expect(window.hasMoreTail).toBe(false);
    window.prependHead(page([], 'sy', 'ey', true, true));
    expect(window.hasMoreHead).toBe(false);
    // 非空页仍然如实透传服务端给的 hasMore。
    window.appendTail(page([3], 's2', 'e2', true, true));
    expect(window.hasMoreTail).toBe(true);
  });

  it('A12 空首页保留边界游标，窗口暂时为空时仍有可用的续翻锚点', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([], 'sEmpty', 'eEmpty', false, true));
    expect(window.loaded).toBe(false);
    expect(window.count).toBe(0);
    expect(window.cursorFor('head')).toBe('sEmpty');
    expect(window.cursorFor('tail')).toBe('eEmpty');
    expect(window.hasMoreTail).toBe(true);
    // 用这个锚点继续翻，拿到真实数据后锚点前进到新页的边界。
    window.appendTail(page([1, 2], 's1', 'e1', false, false));
    expect(window.items).toEqual([1, 2]);
    expect(window.cursorFor('tail')).toBe('e1');
  });

  it('A13 reset 同时清掉空首页留下的边界游标', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([], 'sEmpty', 'eEmpty', true, true));
    window.reset();
    expect(window.cursorFor('head')).toBe('');
    expect(window.cursorFor('tail')).toBe('');
  });

  it('A14 maxPages 小于 1 时被夹到 1，setInitial 与 mergeLive 的裁剪口径一致', () => {
    const zero = new PageWindow<number>(0);
    zero.setInitial(page([1, 2], 's', 'e', false, false));
    expect(zero.count).toBe(2);
    zero.mergeLive(3, 'tail');
    expect(zero.items).toEqual([1, 2, 3]); // 不会被整页裁光
    expect(zero.hasMoreHead).toBe(false);

    const negative = new PageWindow<number>(-5);
    negative.setInitial(page([1], 's', 'e', false, true));
    negative.appendTail(page([2], 's2', 'e2', false, false));
    expect(negative.items).toEqual([2]); // 仍按 1 页裁剪
    expect(negative.hasMoreHead).toBe(true);
  });

  it('A7 normalize 作用于每一页入窗前（setInitial / appendTail / prependHead 都生效）', () => {
    const normalize = vi.fn((items: readonly number[]) => [...items].sort((a, b) => a - b));
    const window = new PageWindow<number>(3, normalize);
    window.setInitial(page([3, 1, 2], 's1', 'e1', true, true));
    expect(window.items).toEqual([1, 2, 3]);
    window.appendTail(page([6, 4, 5], 's2', 'e2', true, true));
    expect(window.items).toEqual([1, 2, 3, 4, 5, 6]);
    window.prependHead(page([0, -1], 's0', 'e0', false, true));
    expect(window.items).toEqual([-1, 0, 1, 2, 3, 4, 5, 6]);
    expect(normalize).toHaveBeenCalledTimes(3);
  });

  it('A8 hasMoreHead / hasMoreTail 只读，无公开 setter（消除外部直写）', () => {
    expect(Object.getOwnPropertyDescriptor(PageWindow.prototype, 'hasMoreHead')?.set).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(PageWindow.prototype, 'hasMoreTail')?.set).toBeUndefined();
  });

  it('A9 reset 清空窗口、游标与 total', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', true, true, 5));
    window.reset();
    expect(window.loaded).toBe(false);
    expect(window.items).toEqual([]);
    expect(window.count).toBe(0);
    expect(window.cursorFor('head')).toBe('');
    expect(window.cursorFor('tail')).toBe('');
    expect(window.hasMoreHead).toBe(false);
    expect(window.hasMoreTail).toBe(false);
    expect(window.total).toBe(-1);
  });

  it('A10 reset 后可以直接续翻式重建（reset 不留任何残留状态）', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', true, true, 5));
    window.reset();
    window.appendTail(page([9], 's9', 'e9', false, false));
    expect(window.items).toEqual([9]);
    expect(window.cursorFor('head')).toBe('s9');
    expect(window.cursorFor('tail')).toBe('e9');
  });
});

// ───────────────────────── B 整页裁剪 ─────────────────────────

describe('PageWindow / B 整页裁剪', () => {
  it('B1 appendTail 超过 maxPages 时整页裁首并标记 hasMoreHead', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([3, 4], 's2', 'e2', true, true));
    expect(window.items).toEqual([1, 2, 3, 4]);
    expect(window.cursorFor('tail')).toBe('e2');
    expect(window.hasMoreHead).toBe(false);
    expect(window.hasMoreTail).toBe(true);

    window.appendTail(page([5, 6], 's3', 'e3', true, false));
    expect(window.items).toEqual([3, 4, 5, 6]);
    expect(window.cursorFor('head')).toBe('s2');
    expect(window.cursorFor('tail')).toBe('e3');
    expect(window.hasMoreHead).toBe(true);
    expect(window.hasMoreTail).toBe(false);
  });

  it('B2 prependHead 超过 maxPages 时整页裁尾并标记 hasMoreTail', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([5, 6], 's5', 'e5', true, false));
    window.prependHead(page([3, 4], 's3', 'e3', true, true));
    expect(window.items).toEqual([3, 4, 5, 6]);
    expect(window.cursorFor('head')).toBe('s3');
    expect(window.hasMoreHead).toBe(true);

    window.prependHead(page([1, 2], 's1', 'e1', false, true));
    expect(window.items).toEqual([1, 2, 3, 4]);
    expect(window.cursorFor('tail')).toBe('e3');
    expect(window.hasMoreHead).toBe(false);
    expect(window.hasMoreTail).toBe(true);
  });

  it('B3 maxPages=1：每次续翻都整页替换，两端 hasMore 都被裁剪置真', () => {
    const window = new PageWindow<number>(1);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([3, 4], 's2', 'e2', false, true));
    expect(window.items).toEqual([3, 4]);
    expect(window.hasMoreHead).toBe(true);
    expect(window.cursorFor('head')).toBe('s2');

    window.prependHead(page([1, 2], 's1', 'e1', false, false));
    expect(window.items).toEqual([1, 2]);
    expect(window.hasMoreTail).toBe(true);
    expect(window.cursorFor('tail')).toBe('e1');
  });

  it('B4 单次超额多页时 while 循环把多余页一次裁到位', () => {
    // 构造一个已经有 3 页的窗口，再把 maxPages 收紧是不可能的（构造后不可变），
    // 因此改用「连续 append 三页」验证裁剪按页逐次生效、条目数恒不越界。
    const window = new PageWindow<number>(2);
    window.setInitial(page([1], 's1', 'e1', false, true));
    window.appendTail(page([2], 's2', 'e2', true, true));
    window.appendTail(page([3], 's3', 'e3', true, true));
    window.appendTail(page([4], 's4', 'e4', true, true));
    expect(window.items).toEqual([3, 4]);
    expect(window.count).toBeLessThanOrEqual(2);
  });

  it('B5 窗口条目数不超过 pageSize × maxPages（整页裁剪的核心不变量）', () => {
    const maxPages = 3;
    const pageSize = 4;
    const window = new PageWindow<number>(maxPages);
    window.setInitial(page([1, 2, 3, 4], 's0', 'e0', false, true));
    for (let p = 1; p <= 10; p++) {
      const start = p * pageSize + 1;
      window.appendTail(page([start, start + 1, start + 2, start + 3], `s${p}`, `e${p}`, true, true));
      expect(window.count).toBeLessThanOrEqual(pageSize * maxPages);
    }
  });

  it('B6 裁剪只按页数、不按单页条数：单页超长不会被裁', () => {
    const window = new PageWindow<number>(2);
    const huge = Array.from({ length: 500 }, (_, i) => i);
    window.setInitial(page(huge, 's1', 'e1', false, false));
    expect(window.count).toBe(500);
  });
});

// ───────────────────────── C 跨页去重 ─────────────────────────

describe('PageWindow / C 跨页去重（identityOf）', () => {
  it('C1 appendTail 用新页覆盖旧页同身份条目：同一身份至多出现一次', () => {
    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([1, 2, 3], 's1', 'e1', false, true));
    window.appendTail(page([3, 4, 5], 's2', 'e2', false, false));
    expect(window.items).toEqual([1, 2, 3, 4, 5]);
    const ids = window.items.map(String);
    expect(new Set(ids).size).toBe(ids.length);
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.cursorFor('tail')).toBe('e2');
  });

  it('C2 prependHead 用新页覆盖旧页同身份条目', () => {
    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([3, 4, 5], 's2', 'e2', true, false));
    window.prependHead(page([5, 1, 2], 's1', 'e1', false, true));
    expect(window.items).toEqual([5, 1, 2, 3, 4]);
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.cursorFor('tail')).toBe('e2');
  });

  it('C3 旧页被清空仍保留有效边界游标，不影响续翻', () => {
    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([1, 2, 3], 's2', 'e2', false, false));
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.cursorFor('tail')).toBe('e2');
  });

  it('C4 「裁剪后回滚 + 并发重排」四步路径：同一身份绝不重复显示', () => {
    // §7.2 的四步路径：① 向后滚动裁掉头部页 → ② 某条目重排跳到活跃端 →
    // ③ 用户滚回顶部 prependHead 又带回它 → ④ 朴素拼接会重复。
    const window = new PageWindow<number>(2, undefined, asKey);
    window.setInitial(page([1, 2, 3], 'sA', 'eA', false, true));  // 页A
    window.appendTail(page([4, 5, 6], 'sB', 'eB', true, true)); // 页B
    window.appendTail(page([7, 8, 9], 'sC', 'eC', true, true)); // 页C，裁掉页A
    expect(window.items).toEqual([4, 5, 6, 7, 8, 9]);
    expect(window.hasMoreHead).toBe(true);
    // 条目 5 重排跳到更活跃端，用户滚回顶部时新页里又出现了 5
    window.prependHead(page([5, 1, 2], 'sA2', 'eA2', true, true));
    const ids = window.items.map(String);
    expect(new Set(ids).size).toBe(ids.length);
    expect(window.items).toEqual([5, 1, 2, 4, 6]);
  });

  it('C5 整页被去重清空后立即回收页位，不再挤掉另一端的真实数据页', () => {
    const window = new PageWindow<number>(2, undefined, asKey);
    window.setInitial(page([1, 2], 'sA', 'eA', false, true));
    window.appendTail(page([1, 2], 'sB', 'eB', true, true)); // 页A 被完全清空并回收
    expect(window.items).toEqual([1, 2]);
    // 窗口的 backward 边界不因页被回收而改变：sA 之前（以及页A 自己的区间）仍未加载。
    expect(window.cursorFor('head')).toBe('sA');

    // 关键回归：此时只占 1 个页位，再来一页不会触发 maxPages 淘汰，
    // 两页真实数据都留在窗口里。空页占位的旧实现在这里会裁掉一整页真实数据。
    window.appendTail(page([3], 'sC', 'eC', true, false));
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.cursorFor('head')).toBe('sA');
    expect(window.hasMoreHead).toBe(false);
  });

  it('C6 未提供 identityOf 时不跨页去重（保持消息窗口的默认行为）', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1, 2, 3], 's1', 'e1', false, true));
    window.appendTail(page([3, 4, 5], 's2', 'e2', false, false));
    expect(window.items).toEqual([1, 2, 3, 3, 4, 5]);
  });

  it('C7 新页为空 / 窗口为空时去重是空操作，不抛错', () => {
    const empty = new PageWindow<number>(3, undefined, asKey);
    empty.appendTail(page([1], 's', 'e', false, false)); // 窗口本来就没有页
    expect(empty.items).toEqual([1]);

    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([], 's2', 'e2', false, true)); // 新页为空
    expect(window.items).toEqual([1, 2]);
  });

  it('C8 同一页内部的重复身份不由去重负责（去重只跨页）', () => {
    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([1, 1, 2], 's1', 'e1', false, false));
    expect(window.items).toEqual([1, 1, 2]); // 页内重复要靠 normalize 处理
  });

  it('C9 hasIdentity：命中窗口内条目返回 true，未命中或未提供 identityOf 返回 false', () => {
    const withId = new PageWindow<number>(3, undefined, asKey);
    withId.setInitial(page([1, 2, 3], 's1', 'e1', false, false));
    expect(withId.hasIdentity('2')).toBe(true);
    expect(withId.hasIdentity('99')).toBe(false);

    const withoutId = new PageWindow<number>(3);
    withoutId.setInitial(page([1, 2, 3], 's1', 'e1', false, false));
    expect(withoutId.hasIdentity('2')).toBe(false);
  });

  it('C10 hasIdentity 跨多页查找，且条目被删除后立即返回 false', () => {
    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([3, 4], 's2', 'e2', true, false));
    expect(window.hasIdentity('4')).toBe(true);
    window.removeMatching((n) => n === 4);
    expect(window.hasIdentity('4')).toBe(false);
  });
});

// ───────────────────────── D 就地增删改 ─────────────────────────

describe('PageWindow / D 就地增删改', () => {
  it('D1 updateMatching 就地替换命中条目，页结构与边界游标不变', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([3, 4], 's2', 'e2', false, false));
    expect(window.updateMatching((n) => n === 2, () => 20)).toBe(true);
    expect(window.items).toEqual([1, 20, 3, 4]);
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.cursorFor('tail')).toBe('e2');
  });

  it('D2 updateMatching 未命中返回 false 且不改动任何条目', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, false));
    expect(window.updateMatching((n) => n === 99, () => 0)).toBe(false);
    expect(window.items).toEqual([1, 2]);
  });

  it('D3 updateMatching 跨页多命中时全部替换', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1, 2, 1], 's1', 'e1', false, true));
    window.appendTail(page([1, 3], 's2', 'e2', false, false));
    expect(window.updateMatching((n) => n === 1, () => 100)).toBe(true);
    expect(window.items).toEqual([100, 2, 100, 100, 3]);
  });

  it('D4 removeMatching 就地删除命中条目，剩余条目自然补齐', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([3, 4], 's2', 'e2', false, false));
    expect(window.removeMatching((n) => n === 2 || n === 3)).toBe(true);
    expect(window.items).toEqual([1, 4]);
  });

  it('D5 removeMatching 未命中返回 false', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, false));
    expect(window.removeMatching((n) => n === 99)).toBe(false);
    expect(window.items).toEqual([1, 2]);
  });

  it('D6 removeMatching 删空整页后游标仍有效，页数不变', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([3, 4], 's2', 'e2', true, false));
    expect(window.removeMatching((n) => n === 1 || n === 2)).toBe(true);
    expect(window.items).toEqual([3, 4]);
    expect(window.cursorFor('head')).toBe('s1'); // 空页仍是首页
    expect(window.cursorFor('tail')).toBe('e2');
  });

  it('D7 删光全部条目后空页被回收，但窗口边界仍然保留', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, false));
    window.removeMatching(() => true);
    expect(window.items).toEqual([]);
    expect(window.count).toBe(0);
    expect(window.loaded).toBe(false); // 空页不再占页位
    // 边界与 pages 解耦：页没了，续翻锚点还在，窗口仍能从原位置续翻。
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.cursorFor('tail')).toBe('e1');
  });
  it('D8 中间页被 removeMatching 删空后回收，续翻不再淘汰另一端的真实数据页', () => {
    // BL-BUG-013 回归：空页留在数组里会挤占 maxPages 名额，随后的 prepend/append
    // 按 maxPages 淘汰时淘汰的是另一端的真实数据页——用户翻一页净损失一页内容。
    const window = new PageWindow<number>(3);
    window.setInitial(page([1, 2], 's1', 'e1', true, true));
    window.appendTail(page([3], 's2', 'e2', true, true));   // 中间页，只有一条
    window.appendTail(page([4, 5], 's3', 'e3', true, true));
    expect(window.items).toEqual([1, 2, 3, 4, 5]);

    window.removeMatching((item) => item === 3); // 中间页被删空
    expect(window.items).toEqual([1, 2, 4, 5]);

    // 只剩 2 个页位；再来一页正好填满 maxPages，两端真实数据都不该被淘汰。
    window.appendTail(page([6, 7], 's4', 'e4', true, false));
    expect(window.items).toEqual([1, 2, 4, 5, 6, 7]);
    expect(window.hasMoreHead).toBe(true); // 保持 setInitial 的取值，没有因淘汰被改写
    expect(window.cursorFor('head')).toBe('s1');
  });

  it('D9 首页被删空后回收，backward 边界仍停在原处，不会跳过未加载区间', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1], 's1', 'e1', true, true));
    window.appendTail(page([2, 3], 's2', 'e2', true, false));

    window.removeMatching((item) => item === 1); // 首页被删空并回收
    expect(window.items).toEqual([2, 3]);
    // 锚点不跟着页走：s1 之前仍未加载，从 s1 续翻才不会跳过数据。
    expect(window.cursorFor('head')).toBe('s1');
    expect(window.hasMoreHead).toBe(true);
  });
});

// ───────────────────────── E 实时并入 mergeLive ─────────────────────────

describe('PageWindow / E 实时并入 mergeLive', () => {
  it('E1 edge=tail 并入尾页；调用前新鲜端 hasMoreTail 已是 false，并入后保持不变', () => {
    // mergeLive 的前置契约：只有窗口已经追平新鲜端（该端 hasMore 已为 false）才能调用，
    // 它自己不会替调用方把 hasMore 改成 false（BL-BUG：曾经无条件置 false，导致窗口
    // 未追平时误关真正的续翻，见 bounded-list.ts upsertLocal 的 reachesFreshEdge 守卫）。
    const window = new PageWindow<number>(2, (items) => [...new Set(items)].sort((a, b) => a - b));
    window.setInitial(page([1, 3], 's1', 'e1', false, false));
    window.mergeLive(2, 'tail');
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.hasMoreTail).toBe(false);
    window.mergeLive(2, 'tail'); // 重复 live 条目被 normalize 去重
    expect(window.items).toEqual([1, 2, 3]);
  });

  it('E1b mergeLive 不会替调用方把仍为 true 的新鲜端 hasMore 改成 false', () => {
    const window = new PageWindow<number>(2, (items) => [...new Set(items)].sort((a, b) => a - b));
    window.setInitial(page([1, 3], 's1', 'e1', false, true));
    window.mergeLive(2, 'tail');
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.hasMoreTail).toBe(true); // 窗口本就没追平，mergeLive 如实保留
  });

  it('E2 edge=head 并入首页；调用前新鲜端 hasMoreHead 已是 false，并入后保持不变', () => {
    const window = new PageWindow<number>(1);
    window.setInitial(page([2, 3], 's1', 'e1', false, false));
    window.mergeLive(1, 'head');
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.hasMoreHead).toBe(false);
  });

  it('E3 窗口为空时自建一页并标记已加载；没有可用游标时两端 hasMore 一并置 false', () => {
    const window = new PageWindow<number>(2);
    window.mergeLive(1, 'tail');
    expect(window.items).toEqual([1]);
    expect(window.loaded).toBe(true);
    // 从未加载过 → 没有任何边界游标，如实报告「两端都没有更多」，避免带着空游标去请求。
    expect(window.cursorFor('head')).toBe('');
    expect(window.cursorFor('tail')).toBe('');
    expect(window.hasMoreHead).toBe(false);
    expect(window.hasMoreTail).toBe(false);
  });

  it('E3b 空首页留下的 fallback 游标会被自建页继承，续翻锚点不丢', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([], 'sEmpty', 'eEmpty', true, false));
    window.mergeLive(1, 'tail');
    expect(window.items).toEqual([1]);
    expect(window.cursorFor('head')).toBe('sEmpty');
    expect(window.hasMoreHead).toBe(true); // 有锚点就照常保留
    expect(window.hasMoreTail).toBe(false); // 新鲜端已追平
  });

  it('E4 多页窗口下 mergeLive 只并入新鲜端那一页，页数不变、不触发裁剪', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    // hasMoreTail=false：窗口已经追到尾部真实新鲜端，满足 mergeLive('tail') 的前置契约。
    window.appendTail(page([3, 4], 's2', 'e2', true, false));
    window.mergeLive(5, 'tail');
    expect(window.items).toEqual([1, 2, 3, 4, 5]);
    expect(window.hasMoreHead).toBe(false); // 没有新增页，无需裁剪
    expect(window.hasMoreTail).toBe(false);

    window.mergeLive(0, 'head');
    expect(window.items).toEqual([0, 1, 2, 3, 4, 5]);
    expect(window.hasMoreHead).toBe(false);
  });

  it('E5 mergeLive 经 normalize 处理整页（可用于排序 + 去重）', () => {
    const normalize = (items: readonly number[]) => [...new Set(items)].sort((a, b) => a - b);
    const window = new PageWindow<number>(2, normalize);
    window.setInitial(page([5, 1], 's1', 'e1', false, false));
    window.mergeLive(3, 'tail');
    expect(window.items).toEqual([1, 3, 5]);
  });

  it('E6 mergeLive 同样做跨页去重：条目已在别的页时先摘掉旧的再并入', () => {
    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendTail(page([3, 4], 's2', 'e2', true, false));
    window.mergeLive(1, 'tail'); // 1 已经在首页
    expect(window.items).toEqual([2, 3, 4, 1]);
  });

  it('E6b 重复 mergeLive 同一身份是幂等的（本端重发 / 重复回包不会渲染两遍）', () => {
    const window = new PageWindow<number>(3, undefined, asKey);
    window.setInitial(page([1, 2], 's1', 'e1', false, false));
    window.mergeLive(9, 'tail');
    window.mergeLive(9, 'tail');
    window.mergeLive(9, 'tail');
    expect(window.items).toEqual([1, 2, 9]);
  });

  it('E6c 未提供 identityOf 时 mergeLive 不去重（由 normalize 兜底，保持消息窗口原行为）', () => {
    const window = new PageWindow<number>(3);
    window.setInitial(page([1, 2], 's1', 'e1', false, false));
    window.mergeLive(9, 'tail');
    window.mergeLive(9, 'tail');
    expect(window.items).toEqual([1, 2, 9, 9]);
  });

  it('E7 连续 mergeLive 大量条目不突破 pageSize×maxPages 硬预算', () => {
    const window = new PageWindow<number>(2, undefined, undefined, 10);
    window.setInitial(page([0], 's1', 'e1', false, false));
    let evicted = 0;
    for (let i = 1; i <= 500; i++) evicted += window.mergeLive(i, 'tail');
    expect(window.count).toBe(20);
    expect(window.items).toEqual(Array.from({ length: 20 }, (_, index) => 481 + index));
    expect(evicted).toBe(481);
    expect(window.hasMoreHead).toBe(true);
    expect(window.cursorFor('head')).toBe('s1'); // 上层看到 eviction 后会安排权威 reset 修复边界
    expect(window.cursorFor('tail')).toBe('e1');
  });

  it('E8 source 或 normalize 产出超过 pageSize 时三条入窗路径都快速失败', () => {
    const oversized = page([1, 2, 3, 4], 's', 'e', false, true);
    const initial = new PageWindow<number>(2, undefined, undefined, 3);
    expect(() => initial.setInitial(oversized)).toThrow(RangeError);

    const forward = new PageWindow<number>(2, undefined, undefined, 3);
    forward.setInitial(page([1], 's0', 'e0', false, true));
    expect(() => forward.appendTail(oversized)).toThrow(RangeError);
    expect(forward.items).toEqual([1]);

    const backward = new PageWindow<number>(2, (items) => [...items, 99], undefined, 3);
    backward.setInitial(page([1], 's0', 'e0', true, false));
    expect(() => backward.prependHead(page([2, 3, 4], 's', 'e', false, true))).toThrow(RangeError);
    expect(backward.items).toEqual([1, 99]);
  });

  it('E9 非空 source 页被 normalize 为空时仍保留新游标，避免触界重复请求旧页', () => {
    const window = new PageWindow<number>(3, () => [], undefined, 2);
    window.setInitial(page([1], 's0', 'e0', false, true));
    expect(window.cursorFor('tail')).toBe('e0');

    expect(window.appendTail(page([2], 's1', 'e1', true, true))).toBe(0);
    expect(window.cursorFor('tail')).toBe('e1');
    expect(window.hasMoreTail).toBe(true);

    expect(window.appendTail(page([], 's2', 'e2', true, true))).toBe(0);
    expect(window.cursorFor('tail')).toBe('e1'); // 真空页不覆盖最后一个有效边界
    expect(window.hasMoreTail).toBe(false);
  });
});

// ───────────────────────── F 大数据量与长序列 ─────────────────────────

describe('PageWindow / F 大数据量与长序列', () => {
  it('F1 连续 1000 次 appendTail：条目数恒不越界、身份始终唯一、游标始终来自保留页', () => {
    const maxPages = 5;
    const pageSize = 40;
    const window = new PageWindow<number>(maxPages, undefined, asKey);
    window.setInitial(page(Array.from({ length: pageSize }, (_, i) => i), 's0', 'e0', false, true));
    for (let p = 1; p <= 1000; p++) {
      const base = p * pageSize;
      const items = Array.from({ length: pageSize }, (_, i) => base + i);
      window.appendTail(page(items, `s${p}`, `e${p}`, true, true));
      if (p % 137 === 0) {
        expect(window.count).toBeLessThanOrEqual(pageSize * maxPages);
        const ids = window.items.map(String);
        expect(new Set(ids).size).toBe(ids.length);
        expect(window.cursorFor('tail')).toBe(`e${p}`);
        expect(window.cursorFor('head')).toBe(`s${p - maxPages + 1}`);
      }
    }
    expect(window.count).toBe(pageSize * maxPages);
    expect(window.hasMoreHead).toBe(true);
  });

  it('F2 交替 append / prepend 长序列（模拟用户来回滚动）后不变量仍成立', () => {
    const maxPages = 4;
    const pageSize = 10;
    const total = 5000;
    const all = Array.from({ length: total }, (_, i) => i);
    const window = new PageWindow<number>(maxPages, undefined, asKey);
    let start = 2000;
    window.setInitial(page(all.slice(start, start + pageSize), `s${start}`, `e${start + pageSize}`, true, true));

    let forwardEnd = start + pageSize;
    let backwardStart = start;
    for (let step = 0; step < 400; step++) {
      if (step % 3 === 2) {
        const from = Math.max(0, backwardStart - pageSize);
        window.prependHead(page(all.slice(from, backwardStart), `s${from}`, `e${backwardStart}`, from > 0, true));
        backwardStart = from;
      } else {
        const to = Math.min(total, forwardEnd + pageSize);
        window.appendTail(page(all.slice(forwardEnd, to), `s${forwardEnd}`, `e${to}`, true, to < total));
        forwardEnd = to;
      }
      expect(window.count).toBeLessThanOrEqual(pageSize * maxPages);
      const ids = window.items.map(String);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('F3 每一页都与相邻页重叠一半的极端情况下，窗口内仍无重复身份', () => {
    const window = new PageWindow<number>(4, undefined, asKey);
    window.setInitial(page([0, 1, 2, 3], 's0', 'e0', false, true));
    for (let p = 1; p <= 200; p++) {
      const base = p * 2;
      window.appendTail(page([base, base + 1, base + 2, base + 3], `s${p}`, `e${p}`, true, true));
      const ids = window.items.map(String);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(window.count).toBeLessThanOrEqual(16);
  });

  it('F4 大窗口内 updateMatching / removeMatching / hasIdentity 仍然逐条精确', () => {
    const window = new PageWindow<number>(10, undefined, asKey);
    window.setInitial(page(Array.from({ length: 100 }, (_, i) => i), 's0', 'e0', false, true));
    for (let p = 1; p < 10; p++) {
      const base = p * 100;
      window.appendTail(page(Array.from({ length: 100 }, (_, i) => base + i), `s${p}`, `e${p}`, true, true));
    }
    expect(window.count).toBe(1000);
    expect(window.hasIdentity('999')).toBe(true);
    expect(window.updateMatching((n) => n % 100 === 0, (n) => n + 1_000_000)).toBe(true);
    expect(window.items.filter((n) => n >= 1_000_000)).toHaveLength(10);
    expect(window.removeMatching((n) => n >= 1_000_000)).toBe(true);
    expect(window.count).toBe(990);
    expect(window.hasIdentity('0')).toBe(false);
  });
});
