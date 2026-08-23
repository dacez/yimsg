// 输入防抖（views/utils 的 debounce）单测。
// BoundedList 不再自带防抖：「输入停顿多久才查」是搜索框的交互决定，见 setQuery 移除的理由。

import { describe, expect, it, vi } from 'vitest';
import { debounce, SEARCH_DEBOUNCE_MS } from '../../../src/app/utils';

describe('debounce', () => {
  it('A1 窗口内的多次调用只执行最后一次', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn);
      debounced('a');
      debounced('ab');
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('ab');
    } finally {
      vi.useRealTimers();
    }
  });

  it('A2 flush 立即执行并作废待触发的那次', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn);
      debounced('a');
      debounced.flush('');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('');
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('A3 cancel 之后待触发的那次不再执行（宿主销毁时用）', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn);
      debounced('a');
      debounced.cancel();
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('A4 间隔超过窗口的多次调用各自执行', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debounced = debounce(fn, 50);
      debounced('a');
      vi.advanceTimersByTime(50);
      debounced('b');
      vi.advanceTimersByTime(50);
      expect(fn.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });
});
