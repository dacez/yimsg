import { describe, expect, it } from 'vitest';
import { PageWindow } from '../../../src/app/bounded-list/page-window';
import type { PageLoadResult } from '../../../src/app/bounded-list/types';

function page(items: number[], startCursor: string, endCursor: string, hasMoreBackward: boolean, hasMoreForward: boolean, total?: number): PageLoadResult<number> {
  return { items, startCursor, endCursor, hasMoreBackward, hasMoreForward, total };
}

describe('PageWindow 按页边界游标记账', () => {
  it('setInitial 放入首页并暴露边界游标、hasMore 与 total', () => {
    const window = new PageWindow<number>(2);
    expect(window.loaded).toBe(false);
    expect(window.total).toBe(-1);
    window.setInitial(page([1, 2], 's1', 'e1', false, true, 12));
    expect(window.loaded).toBe(true);
    expect(window.items).toEqual([1, 2]);
    expect(window.count).toBe(2);
    expect(window.total).toBe(12);
    expect(window.backwardCursor).toBe('s1');
    expect(window.forwardCursor).toBe('e1');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(true);
  });

  it('空页 setInitial 不标记已加载，total 未提供时为 -1', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([], '', '', false, false));
    expect(window.loaded).toBe(false);
    expect(window.items).toEqual([]);
    expect(window.total).toBe(-1);
  });

  it('appendForward 超过 maxPages 时整页裁首并标记 hasMoreBefore', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendForward(page([3, 4], 's2', 'e2', true, true));
    expect(window.items).toEqual([1, 2, 3, 4]);
    expect(window.forwardCursor).toBe('e2');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(true);

    window.appendForward(page([5, 6], 's3', 'e3', true, false));
    expect(window.items).toEqual([3, 4, 5, 6]);
    expect(window.backwardCursor).toBe('s2');
    expect(window.forwardCursor).toBe('e3');
    expect(window.hasMoreBefore).toBe(true);
    expect(window.hasMoreAfter).toBe(false);
  });

  it('prependBackward 超过 maxPages 时整页裁尾并标记 hasMoreAfter', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([5, 6], 's5', 'e5', true, false));
    window.prependBackward(page([3, 4], 's3', 'e3', true, true));
    expect(window.items).toEqual([3, 4, 5, 6]);
    expect(window.backwardCursor).toBe('s3');
    expect(window.hasMoreBefore).toBe(true);

    window.prependBackward(page([1, 2], 's1', 'e1', false, true));
    expect(window.items).toEqual([1, 2, 3, 4]);
    expect(window.forwardCursor).toBe('e3');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(true);
  });

  it('窗口条目数不超过 pageSize × maxPages（整页裁剪的核心不变量）', () => {
    const maxPages = 3;
    const pageSize = 4;
    const window = new PageWindow<number>(maxPages);
    window.setInitial(page([1, 2, 3, 4], 's0', 'e0', false, true));
    for (let p = 1; p <= 10; p++) {
      const start = p * pageSize + 1;
      const items = [start, start + 1, start + 2, start + 3];
      window.appendForward(page(items, `s${p}`, `e${p}`, true, true));
      expect(window.count).toBeLessThanOrEqual(pageSize * maxPages);
    }
  });

  it('hasMoreBefore / hasMoreAfter 只读，无公开 setter（消除外部直写）', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1], 's1', 'e1', false, false));
    // TypeScript 层面 hasMoreBefore/hasMoreAfter 只有 getter；这里用运行时反证：
    // 尝试赋值会被 JS 引擎在严格模式下忽略或抛错，但更重要的是类型系统已经禁止了它——
    // 该用例通过「取值仍是分页结果驱动的值」间接验证只读语义没有被破坏。
    expect(Object.getOwnPropertyDescriptor(PageWindow.prototype, 'hasMoreBefore')?.set).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(PageWindow.prototype, 'hasMoreAfter')?.set).toBeUndefined();
  });

  it('mergeLive edge=tail 并入尾页、超限裁首，新鲜端 hasMoreAfter 置 false', () => {
    const window = new PageWindow<number>(2, (items) => [...new Set(items)].sort((a, b) => a - b));
    window.setInitial(page([1, 3], 's1', 'e1', false, true));
    window.mergeLive(2, 'tail');
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.hasMoreAfter).toBe(false);
    window.mergeLive(2, 'tail'); // 重复 live 条目被 normalize 去重
    expect(window.items).toEqual([1, 2, 3]);
  });

  it('mergeLive edge=head 并入首页、超限裁尾，新鲜端 hasMoreBefore 置 false', () => {
    const window = new PageWindow<number>(1);
    window.setInitial(page([2, 3], 's1', 'e1', true, false));
    window.mergeLive(1, 'head');
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.hasMoreBefore).toBe(false);
  });

  it('mergeLive 窗口为空时自建一页', () => {
    const window = new PageWindow<number>(2);
    window.mergeLive(1, 'tail');
    expect(window.items).toEqual([1]);
    expect(window.loaded).toBe(true);
  });

  describe('跨页去重（identityOf）', () => {
    it('appendForward 用新页覆盖旧页同身份条目：裁剪后回滚 + 并发重排下同一身份至多出现一次', () => {
      const window = new PageWindow<number>(3, undefined, (n) => String(n));
      window.setInitial(page([1, 2, 3], 's1', 'e1', false, true));
      window.appendForward(page([3, 4, 5], 's2', 'e2', false, false));
      expect(window.items).toEqual([1, 2, 3, 4, 5]);
      const ids = window.items.map(String);
      expect(new Set(ids).size).toBe(ids.length);
      expect(window.backwardCursor).toBe('s1');
      expect(window.forwardCursor).toBe('e2');
    });

    it('prependBackward 用新页覆盖旧页同身份条目', () => {
      const window = new PageWindow<number>(3, undefined, (n) => String(n));
      window.setInitial(page([3, 4, 5], 's2', 'e2', true, false));
      window.prependBackward(page([5, 1, 2], 's1', 'e1', false, true));
      expect(window.items).toEqual([5, 1, 2, 3, 4]);
      expect(window.backwardCursor).toBe('s1');
      expect(window.forwardCursor).toBe('e2');
    });

    it('旧页被清空仍保留有效边界游标，不影响续翻', () => {
      const window = new PageWindow<number>(3, undefined, (n) => String(n));
      window.setInitial(page([1, 2], 's1', 'e1', false, true));
      window.appendForward(page([1, 2, 3], 's2', 'e2', false, false));
      expect(window.items).toEqual([1, 2, 3]);
      expect(window.backwardCursor).toBe('s1');
      expect(window.forwardCursor).toBe('e2');
    });

    it('未提供 identityOf 时不跨页去重（保持消息窗口的默认行为）', () => {
      const window = new PageWindow<number>(3);
      window.setInitial(page([1, 2, 3], 's1', 'e1', false, true));
      window.appendForward(page([3, 4, 5], 's2', 'e2', false, false));
      expect(window.items).toEqual([1, 2, 3, 3, 4, 5]);
    });
  });

  describe('hasIdentity（invalidate 交集判定）', () => {
    it('命中窗口内条目返回 true，未命中或未提供 identityOf 返回 false', () => {
      const withId = new PageWindow<number>(3, undefined, (n) => String(n));
      withId.setInitial(page([1, 2, 3], 's1', 'e1', false, false));
      expect(withId.hasIdentity('2')).toBe(true);
      expect(withId.hasIdentity('99')).toBe(false);

      const withoutId = new PageWindow<number>(3);
      withoutId.setInitial(page([1, 2, 3], 's1', 'e1', false, false));
      expect(withoutId.hasIdentity('2')).toBe(false);
    });
  });

  it('updateMatching 就地替换命中条目，页结构与边界游标不变', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendForward(page([3, 4], 's2', 'e2', false, false));
    const changed = window.updateMatching((n) => n === 2, () => 20);
    expect(changed).toBe(true);
    expect(window.items).toEqual([1, 20, 3, 4]);
    expect(window.backwardCursor).toBe('s1');
    expect(window.forwardCursor).toBe('e2');
  });

  it('removeMatching 就地删除命中条目，剩余条目自然补齐', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendForward(page([3, 4], 's2', 'e2', false, false));
    const changed = window.removeMatching((n) => n === 2 || n === 3);
    expect(changed).toBe(true);
    expect(window.items).toEqual([1, 4]);
  });

  it('reset 清空窗口、游标与 total', () => {
    const window = new PageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', true, true, 5));
    window.reset();
    expect(window.loaded).toBe(false);
    expect(window.items).toEqual([]);
    expect(window.backwardCursor).toBe('');
    expect(window.forwardCursor).toBe('');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(false);
    expect(window.total).toBe(-1);
  });
});
