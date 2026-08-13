// LocalOverlay（本地层）单测。
// 覆盖口径见 packages/uikit/docs/boundedlist/测试方案.md §4.3。

import { describe, expect, it } from 'vitest';
import { LocalOverlay } from '../../../src/app/bounded-list/overlay';
import { idOf, makeTestItems, type TestItem } from './test-sources';

function apply(overlay: LocalOverlay<TestItem>, base: readonly TestItem[], edge: 'head' | 'tail'): string[] {
  return overlay.apply(base, edge, idOf).map((item) => item.label);
}

describe('LocalOverlay 叠加语义', () => {
  it('空本地层原样返回权威序列', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    expect(apply(overlay, makeTestItems(3), 'head')).toEqual(['item-0', 'item-1', 'item-2']);
  });

  it('put 新身份：head 端落在最前，tail 端落在最后', () => {
    const head = new LocalOverlay<TestItem>(8);
    head.put('9', { id: 9, label: 'local' });
    expect(apply(head, makeTestItems(2), 'head')).toEqual(['local', 'item-0', 'item-1']);

    const tail = new LocalOverlay<TestItem>(8);
    tail.put('9', { id: 9, label: 'local' });
    expect(apply(tail, makeTestItems(2), 'tail')).toEqual(['item-0', 'item-1', 'local']);
  });

  it('put 已在权威序列里的身份：从原位置摘掉并移到新鲜端（会话置顶语义）', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    overlay.put('2', { id: 2, label: 'promoted' });
    expect(apply(overlay, makeTestItems(3), 'head')).toEqual(['promoted', 'item-0', 'item-1']);
  });

  it('多次 put 按记账序排列：head 端最后记的排最前', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    overlay.put('7', { id: 7, label: 'a' });
    overlay.put('8', { id: 8, label: 'b' });
    expect(apply(overlay, makeTestItems(1), 'head')).toEqual(['b', 'a', 'item-0']);
    expect(apply(overlay, makeTestItems(1), 'tail')).toEqual(['item-0', 'a', 'b']);
  });

  it('重复 put 同一身份只留一条，并移到记账序最后', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    overlay.put('7', { id: 7, label: 'a1' });
    overlay.put('8', { id: 8, label: 'b' });
    overlay.put('7', { id: 7, label: 'a2' });
    expect(apply(overlay, [], 'tail')).toEqual(['b', 'a2']);
    expect(overlay.size).toBe(2);
  });

  it('drop 把该身份从渲染序列里摘掉', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    overlay.drop('1');
    expect(apply(overlay, makeTestItems(3), 'head')).toEqual(['item-0', 'item-2']);
  });

  it('先 put 后 drop 只留删除态', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    overlay.put('9', { id: 9, label: 'local' });
    overlay.drop('9');
    expect(apply(overlay, makeTestItems(1), 'head')).toEqual(['item-0']);
  });
});

describe('LocalOverlay 生命周期', () => {
  it('settle 只丢弃 mark 之前（含）的记账，之后记的保留', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    overlay.put('7', { id: 7, label: 'before' });
    const mark = overlay.mark();
    overlay.put('8', { id: 8, label: 'after' });

    overlay.settle(mark);
    expect(apply(overlay, [], 'tail')).toEqual(['after']);
  });

  it('clear 清空全部记账', () => {
    const overlay = new LocalOverlay<TestItem>(8);
    overlay.put('7', { id: 7, label: 'a' });
    overlay.drop('1');
    overlay.clear();
    expect(overlay.size).toBe(0);
    expect(apply(overlay, makeTestItems(2), 'head')).toEqual(['item-0', 'item-1']);
  });

  it('超过上限时静默丢弃最旧的一条，保持有界', () => {
    const overlay = new LocalOverlay<TestItem>(2);
    overlay.put('1', { id: 1, label: 'a' });
    overlay.put('2', { id: 2, label: 'b' });
    overlay.put('3', { id: 3, label: 'c' });

    expect(overlay.size).toBe(2);
    expect(overlay.has('1')).toBe(false);
    expect(apply(overlay, [], 'tail')).toEqual(['b', 'c']);
  });
});
