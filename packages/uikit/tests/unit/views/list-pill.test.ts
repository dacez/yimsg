// 提示条（views/list-pill）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.5：A 挂载与显隐 / B 点击 / C 释放。
//
// 它在宿主侧而不是 BoundedList 里：见 src/app/views/list-pill.ts 文件头。

import { describe, expect, it, vi } from 'vitest';
import { createListPill } from '../../../src/app/views/list-pill';
import type { BoundedListState } from '../../../src/app/bounded-list';
import { FakeDocument, asElement } from '../bounded-list/fake-dom';

const IDLE: BoundedListState = {
  loaded: true,
  loading: false,
  loadingBackward: false,
  loadingForward: false,
  hasMoreBackward: false,
  hasMoreForward: false,
  count: 0,
  total: -1,
  stale: false,
  atFreshEdge: true,
  failed: false,
};

const stateOf = (patch: Partial<BoundedListState>): BoundedListState => ({ ...IDLE, ...patch });

const BOTH = { updated: () => '有更新', retry: () => '重新加载' };

// ───────────────────────── A 挂载与显隐 ─────────────────────────

describe('createListPill / A 挂载与显隐', () => {
  it('A1 挂载到 host 下，默认隐藏，stale 时显示「有更新」', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createListPill(asElement(host), () => {}, BOTH);
    expect(host.children).toHaveLength(1);
    expect(host.children[0].classList.contains('hidden')).toBe(true);

    pill.sync(stateOf({ stale: true }));
    expect(host.children[0].classList.contains('hidden')).toBe(false);
    expect(host.children[0].textContent).toBe('有更新');

    pill.sync(IDLE);
    expect(host.children[0].classList.contains('hidden')).toBe(true);
  });

  it('A2 初始 class 同时带基础样式与列表提示条样式', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    createListPill(asElement(host), () => {}, BOTH);
    const cls = host.children[0].classList;
    expect(cls.contains('list-updated-pill')).toBe(true);
    expect(cls.contains('new-message-pill')).toBe(true);
    expect(cls.contains('hidden')).toBe(true);
  });

  it('A3 failed 时显示重试文案，优先于「有更新」', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createListPill(asElement(host), () => {}, BOTH);
    pill.sync(stateOf({ failed: true, stale: true }));
    expect(host.children[0].classList.contains('hidden')).toBe(false);
    expect(host.children[0].textContent).toBe('重新加载');
  });

  it('A4 没有提供对应文案时不出现空白提示条', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    // 只给 retry：这个列表不做「有更新」提示，只在首屏失败时给重试入口。
    const pill = createListPill(asElement(host), () => {}, { retry: () => '重新加载' });
    pill.sync(stateOf({ stale: true }));
    expect(host.children[0].classList.contains('hidden')).toBe(true);

    pill.sync(stateOf({ failed: true }));
    expect(host.children[0].classList.contains('hidden')).toBe(false);
    expect(host.children[0].textContent).toBe('重新加载');
  });

  it('A5 反复同步是幂等的，不会重复挂载节点', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createListPill(asElement(host), () => {}, BOTH);
    for (let i = 0; i < 50; i++) pill.sync(stateOf({ stale: i % 2 === 0 }));
    expect(host.children).toHaveLength(1);
    expect(host.children[0].classList.contains('hidden')).toBe(true);
  });

  it('A6 多个提示条挂在同一个 host 下互不干扰', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const a = createListPill(asElement(host), () => {}, BOTH);
    const b = createListPill(asElement(host), () => {}, BOTH);
    a.sync(stateOf({ stale: true }));
    expect(host.children).toHaveLength(2);
    expect(host.children[0].textContent).toBe('有更新');
    expect(host.children[1].classList.contains('hidden')).toBe(true);
    b.dispose();
    expect(host.children).toHaveLength(1);
    a.dispose();
  });
});

// ───────────────────────── B 点击 ─────────────────────────

describe('createListPill / B 点击', () => {
  it('B1 点击提示条触发 onClick（生产里就是 list.catchUp()）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    createListPill(asElement(host), onClick, BOTH);
    host.children[0].dispatch('click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('B2 隐藏状态下的点击同样会触发（显隐由 CSS 负责，这里不额外拦截）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    const pill = createListPill(asElement(host), onClick, BOTH);
    pill.sync(IDLE);
    host.children[0].dispatch('click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('B3 连续点击每次都回调（追平请求由 BoundedList 自己合并）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    createListPill(asElement(host), onClick, BOTH);
    for (let i = 0; i < 5; i++) host.children[0].dispatch('click');
    expect(onClick).toHaveBeenCalledTimes(5);
  });
});

// ───────────────────────── C 释放 ─────────────────────────

describe('createListPill / C 释放', () => {
  it('C1 dispose 移除 DOM 节点并注销点击监听', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    const pill = createListPill(asElement(host), onClick, BOTH);
    const pillEl = host.children[0];
    expect(pillEl.listenerCount('click')).toBe(1);
    pill.dispose();
    expect(host.children).toHaveLength(0);
    expect(pillEl.listenerCount('click')).toBe(0);
    pillEl.dispatch('click');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('C2 dispose 之后 sync 不再影响 host（节点已摘除）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createListPill(asElement(host), () => {}, BOTH);
    pill.dispose();
    expect(() => pill.sync(stateOf({ stale: true }))).not.toThrow();
    expect(host.children).toHaveLength(0);
  });

  it('C3 dispose 幂等：重复调用不抛错', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createListPill(asElement(host), () => {}, BOTH);
    expect(() => { pill.dispose(); pill.dispose(); }).not.toThrow();
    expect(host.children).toHaveLength(0);
  });
});
