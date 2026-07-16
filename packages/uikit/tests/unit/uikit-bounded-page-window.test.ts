import { describe, expect, it } from 'vitest';
import { BoundedPageWindow, type PageLoadResult } from '../../src/app/bounded-page-window';

function page(items: number[], startCursor: string, endCursor: string, hasMoreBackward: boolean, hasMoreForward: boolean): PageLoadResult<number> {
  return { items, startCursor, endCursor, hasMoreBackward, hasMoreForward };
}

describe('BoundedPageWindow 按页边界游标记账', () => {
  it('setInitial 放入首页并暴露边界游标与 hasMore', () => {
    const window = new BoundedPageWindow<number>(2);
    expect(window.loaded).toBe(false);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    expect(window.loaded).toBe(true);
    expect(window.items).toEqual([1, 2]);
    expect(window.count).toBe(2);
    expect(window.backwardCursor).toBe('s1');
    expect(window.forwardCursor).toBe('e1');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(true);
  });

  it('空页 setInitial 不标记已加载', () => {
    const window = new BoundedPageWindow<number>(2);
    window.setInitial(page([], '', '', false, false));
    expect(window.loaded).toBe(false);
    expect(window.items).toEqual([]);
  });

  it('appendForward 超过 maxPages 时整页裁首并标记 hasMoreBefore', () => {
    const window = new BoundedPageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    window.appendForward(page([3, 4], 's2', 'e2', true, true));
    expect(window.items).toEqual([1, 2, 3, 4]);
    expect(window.forwardCursor).toBe('e2');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(true);

    window.appendForward(page([5, 6], 's3', 'e3', true, false));
    // 3 页超过上限 2：裁掉首页，向前续翻锚点变为保留首页 start_cursor。
    expect(window.items).toEqual([3, 4, 5, 6]);
    expect(window.backwardCursor).toBe('s2');
    expect(window.forwardCursor).toBe('e3');
    expect(window.hasMoreBefore).toBe(true);
    expect(window.hasMoreAfter).toBe(false);
  });

  it('prependBackward 超过 maxPages 时整页裁尾并标记 hasMoreAfter', () => {
    const window = new BoundedPageWindow<number>(2);
    window.setInitial(page([5, 6], 's5', 'e5', true, false));
    window.prependBackward(page([3, 4], 's3', 'e3', true, true));
    expect(window.items).toEqual([3, 4, 5, 6]);
    expect(window.backwardCursor).toBe('s3');
    expect(window.hasMoreBefore).toBe(true);

    window.prependBackward(page([1, 2], 's1', 'e1', false, true));
    // 3 页超过上限 2：裁掉尾页，向后续翻锚点变为保留尾页 end_cursor。
    expect(window.items).toEqual([1, 2, 3, 4]);
    expect(window.forwardCursor).toBe('e3');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(true);
  });

  it('appendLive 用 normalize 归一化尾页（去重 / 排序）', () => {
    const window = new BoundedPageWindow<number>(2, (items) => [...new Set(items)].sort((a, b) => a - b));
    window.setInitial(page([1, 3], 's1', 'e1', false, false));
    window.appendLive(2);
    expect(window.items).toEqual([1, 2, 3]);
    window.appendLive(2); // 重复 live 条目被去重
    expect(window.items).toEqual([1, 2, 3]);
  });

  it('identityOf 跨页去重：appendForward 用新页覆盖旧页同身份条目', () => {
    // 模拟会话重排：首页含 [1,2,3]，续翻向后的新页因重排又带回了 3，旧的 3 必须被覆盖删除。
    const window = new BoundedPageWindow<number>(3, undefined, (n) => String(n));
    window.setInitial(page([1, 2, 3], 's1', 'e1', false, true));
    window.appendForward(page([3, 4, 5], 's2', 'e2', false, false));
    // 旧页里的 3 被删，新页保留 3；整窗每个身份只出现一次。
    expect(window.items).toEqual([1, 2, 3, 4, 5]);
    expect(window.count).toBe(5);
    // 续翻锚点用首 / 尾页边界游标，不受去重影响。
    expect(window.backwardCursor).toBe('s1');
    expect(window.forwardCursor).toBe('e2');
  });

  it('identityOf 跨页去重：prependBackward 用新页覆盖旧页同身份条目', () => {
    // 模拟会话重排：尾页含 [3,4,5]，触顶向前拉回的更活跃新页带来了 5，旧的 5 必须被覆盖删除。
    const window = new BoundedPageWindow<number>(3, undefined, (n) => String(n));
    window.setInitial(page([3, 4, 5], 's2', 'e2', true, false));
    window.prependBackward(page([5, 1, 2], 's1', 'e1', false, true));
    expect(window.items).toEqual([5, 1, 2, 3, 4]);
    expect(window.backwardCursor).toBe('s1');
    expect(window.forwardCursor).toBe('e2');
  });

  it('identityOf 跨页去重：旧页被清空仍保留有效边界游标，不影响续翻', () => {
    const window = new BoundedPageWindow<number>(3, undefined, (n) => String(n));
    window.setInitial(page([1, 2], 's1', 'e1', false, true));
    // 新页完全覆盖旧页两条 → 旧页变空，但其 start_cursor 仍是有效的向前续翻锚点。
    window.appendForward(page([1, 2, 3], 's2', 'e2', false, false));
    expect(window.items).toEqual([1, 2, 3]);
    expect(window.backwardCursor).toBe('s1');
    expect(window.forwardCursor).toBe('e2');
  });

  it('未提供 identityOf 时不跨页去重（保持消息 / 默认窗口原行为）', () => {
    const window = new BoundedPageWindow<number>(3);
    window.setInitial(page([1, 2, 3], 's1', 'e1', false, true));
    window.appendForward(page([3, 4, 5], 's2', 'e2', false, false));
    expect(window.items).toEqual([1, 2, 3, 3, 4, 5]);
  });

  it('reset 清空窗口与游标', () => {
    const window = new BoundedPageWindow<number>(2);
    window.setInitial(page([1, 2], 's1', 'e1', true, true));
    window.reset();
    expect(window.loaded).toBe(false);
    expect(window.items).toEqual([]);
    expect(window.backwardCursor).toBe('');
    expect(window.forwardCursor).toBe('');
    expect(window.hasMoreBefore).toBe(false);
    expect(window.hasMoreAfter).toBe(false);
  });
});
