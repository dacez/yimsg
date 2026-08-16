// PageWindow（权威分页窗口）单测。
// 覆盖口径见 packages/uikit/docs/boundedlist/测试方案.md §4.2。

import { describe, expect, it } from 'vitest';
import { PageWindow } from '../../../src/app/bounded-list/page-window';
import { idOf, makeTestItems, pageOf, type TestItem } from './test-sources';

function makeWindow(maxPages = 2, pageSize = 3, normalize?: (items: readonly TestItem[]) => TestItem[]): PageWindow<TestItem> {
  return new PageWindow<TestItem>({ maxPages, pageSize, identityOf: idOf, normalize });
}

function labels(window: PageWindow<TestItem>): string[] {
  return window.items.map((item) => item.label);
}

describe('PageWindow 首页', () => {
  it('setFirstPage 整窗替换，两端边界由这一页确立', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf(makeTestItems(3), 'c0', 'c3', false, true, 42));

    expect(labels(window)).toEqual(['item-0', 'item-1', 'item-2']);
    expect(window.count).toBe(3);
    expect(window.total).toBe(42);
    expect(window.cursorFor('head')).toBe('c0');
    expect(window.cursorFor('tail')).toBe('c3');
    expect(window.hasMore('head')).toBe(false);
    expect(window.hasMore('tail')).toBe(true);
  });

  it('首页为空时仍然确立边界，条目为空', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf([], 'c0', 'c0', false, false));

    expect(window.count).toBe(0);
    expect(window.cursorFor('head')).toBe('c0');
    expect(window.total).toBe(-1);
  });

  it('第二次 setFirstPage 丢弃旧内容，不残留旧条目', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf(makeTestItems(3), 'a0', 'a3', false, true));
    window.setFirstPage(pageOf(makeTestItems(2, 10), 'b0', 'b2', false, false));

    expect(labels(window)).toEqual(['item-10', 'item-11']);
    expect(window.hasMore('tail')).toBe(false);
  });

  it('normalize 之后仍超过 pageSize 时抛错，可见窗口不被污染', () => {
    const window = makeWindow(2, 3);
    expect(() => window.setFirstPage(pageOf(makeTestItems(4), 'c0', 'c4', false, false))).toThrow(RangeError);
    expect(window.count).toBe(0);
  });
});

describe('PageWindow 续翻', () => {
  it('两端各自并入一页，只有并入端的边界前进', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf(makeTestItems(3, 3), 'c3', 'c6', true, true));
    window.extend('head', pageOf(makeTestItems(3), 'c0', 'c3', false, true));

    expect(labels(window)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'item-5']);
    expect(window.cursorFor('head')).toBe('c0');
    expect(window.cursorFor('tail')).toBe('c6');
    expect(window.hasMore('head')).toBe(false);
  });

  it('超过 maxPages 时从对端整页淘汰，并把该端边界改回淘汰后的位置', () => {
    const window = makeWindow(2);
    window.setFirstPage(pageOf(makeTestItems(3), 'c0', 'c3', false, true));
    window.extend('tail', pageOf(makeTestItems(3, 3), 'c3', 'c6', false, true));
    window.extend('tail', pageOf(makeTestItems(3, 6), 'c6', 'c9', false, true));

    expect(labels(window)).toEqual(['item-3', 'item-4', 'item-5', 'item-6', 'item-7', 'item-8']);
    expect(window.count).toBe(6);
    expect(window.hasMore('head')).toBe(true);
    expect(window.cursorFor('head')).toBe('c3');
  });

  it('并入新页时先摘掉窗口里的同身份条目，同一身份至多出现一次', () => {
    const window = makeWindow(3);
    window.setFirstPage(pageOf(makeTestItems(3), 'c0', 'c3', false, true));
    window.extend('tail', pageOf([{ id: 2, label: 'item-2-new' }, { id: 9, label: 'item-9' }], 'c3', 'c5', false, true));

    expect(labels(window)).toEqual(['item-0', 'item-1', 'item-2-new', 'item-9']);
  });

  it('拿到空页时该端 hasMore 收敛为 false，游标不前进（服务端违约也不会无限补页）', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf(makeTestItems(3), 'c0', 'c3', false, true));
    window.extend('tail', pageOf([], 'c9', 'c9', false, true));

    expect(window.hasMore('tail')).toBe(false);
    expect(window.cursorFor('tail')).toBe('c3');
  });

  it('normalize 把整页滤空时不占页位，但游标照常前进', () => {
    const window = makeWindow(2, 3, (items) => items.filter((item) => item.id % 2 === 0));
    window.setFirstPage(pageOf(makeTestItems(1), 'c0', 'c1', false, true));
    window.extend('tail', pageOf([{ id: 1, label: 'odd' }], 'c1', 'c2', false, true));

    expect(labels(window)).toEqual(['item-0']);
    expect(window.cursorFor('tail')).toBe('c2');
  });

  it('reset 之后没有任何续翻锚点，此时不允许续翻（由 BoundedList 短路，见 C8）', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf(makeTestItems(3), 'c0', 'c3', true, true));
    window.reset();

    expect(window.cursorFor('head')).toBe('');
    expect(window.cursorFor('tail')).toBe('');
    expect(window.hasMore('head')).toBe(false);
    expect(window.hasMore('tail')).toBe(false);
  });
});

describe('PageWindow 按身份就地增删', () => {
  it('replace 命中时就地替换、不改位置；未命中返回 false', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf(makeTestItems(3), 'c0', 'c3', false, false));

    expect(window.replace('1', { id: 1, label: 'patched' })).toBe(true);
    expect(labels(window)).toEqual(['item-0', 'patched', 'item-2']);
    expect(window.replace('99', { id: 99, label: 'x' })).toBe(false);
  });

  it('remove 命中时摘掉条目并回收空页；未命中返回 false', () => {
    const window = makeWindow(2);
    window.setFirstPage(pageOf(makeTestItems(1), 'c0', 'c1', false, true));
    window.extend('tail', pageOf(makeTestItems(2, 1), 'c1', 'c3', false, true));

    expect(window.remove('0')).toBe(true);
    expect(labels(window)).toEqual(['item-1', 'item-2']);
    // 空页被回收后不再挤占 maxPages 名额：再并入一页不会淘汰真实数据页。
    window.extend('tail', pageOf(makeTestItems(2, 3), 'c3', 'c5', false, false));
    expect(labels(window)).toEqual(['item-1', 'item-2', 'item-3', 'item-4']);
    expect(window.remove('0')).toBe(false);
  });

  it('has 按身份判断窗口命中', () => {
    const window = makeWindow();
    window.setFirstPage(pageOf(makeTestItems(2), 'c0', 'c2', false, false));

    expect(window.has('1')).toBe(true);
    expect(window.has('7')).toBe(false);
  });
});

describe('PageWindow 硬有界', () => {
  it('任意续翻序列之后条目数恒不超过 pageSize×maxPages', () => {
    const window = makeWindow(3, 4);
    window.setFirstPage(pageOf(makeTestItems(4), 'c0', 'c4', true, true));
    for (let i = 1; i <= 20; i++) {
      const edge = i % 3 === 0 ? 'head' : 'tail';
      const start = i * 4;
      window.extend(edge, pageOf(makeTestItems(4, start), `c${start}`, `c${start + 4}`, true, true));
      expect(window.count).toBeLessThanOrEqual(12);
    }
  });
});
