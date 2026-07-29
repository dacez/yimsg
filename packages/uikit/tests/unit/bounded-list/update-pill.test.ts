// 提示条（update-pill）单测。
// 分类见 packages/uikit/docs/boundedlist/测试方案.md §4.5：A 挂载与显隐 / B 点击 / C 释放 / D 空实现。

import { describe, expect, it, vi } from 'vitest';
import { createUpdatePill } from '../../../src/app/bounded-list/update-pill';
import { FakeDocument, asElement } from './fake-dom';

// ───────────────────────── A 挂载与显隐 ─────────────────────────

describe('createUpdatePill / A 挂载与显隐', () => {
  it('A1 挂载到 host 下，默认隐藏，setVisible 控制显隐与文案', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createUpdatePill(asElement(host), () => {});
    expect(host.children).toHaveLength(1);
    expect(host.children[0].classList.contains('hidden')).toBe(true);

    pill.setVisible(true, '有新消息');
    expect(host.children[0].classList.contains('hidden')).toBe(false);
    expect(host.children[0].textContent).toBe('有新消息');

    pill.setVisible(false);
    expect(host.children[0].classList.contains('hidden')).toBe(true);
    expect(host.children[0].textContent).toBe('有新消息'); // 不传 text 时保留上次文案
  });

  it('A2 初始 class 同时带基础样式与列表提示条样式', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    createUpdatePill(asElement(host), () => {});
    const cls = host.children[0].classList;
    expect(cls.contains('list-updated-pill')).toBe(true);
    expect(cls.contains('new-message-pill')).toBe(true);
    expect(cls.contains('hidden')).toBe(true);
  });

  it('A3 传入空字符串文案会真的把文案清空（与「不传」语义不同）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createUpdatePill(asElement(host), () => {});
    pill.setVisible(true, '有 3 条新消息');
    pill.setVisible(true, '');
    expect(host.children[0].textContent).toBe('');
    expect(host.children[0].classList.contains('hidden')).toBe(false);
  });

  it('A4 反复显隐是幂等的，不会重复挂载节点', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createUpdatePill(asElement(host), () => {});
    for (let i = 0; i < 50; i++) pill.setVisible(i % 2 === 0, `第 ${i} 次`);
    expect(host.children).toHaveLength(1);
    expect(host.children[0].textContent).toBe('第 49 次');
    expect(host.children[0].classList.contains('hidden')).toBe(true);
  });

  it('A5 多个提示条挂在同一个 host 下互不干扰', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const a = createUpdatePill(asElement(host), () => {});
    const b = createUpdatePill(asElement(host), () => {});
    a.setVisible(true, 'A');
    expect(host.children).toHaveLength(2);
    expect(host.children[0].textContent).toBe('A');
    expect(host.children[1].classList.contains('hidden')).toBe(true);
    b.dispose();
    expect(host.children).toHaveLength(1);
    a.dispose();
  });
});

// ───────────────────────── B 点击 ─────────────────────────

describe('createUpdatePill / B 点击', () => {
  it('B1 点击提示条触发 onClick', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    createUpdatePill(asElement(host), onClick);
    host.children[0].dispatch('click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('B2 隐藏状态下的点击同样会触发（显隐由 CSS 负责，组件不额外拦截）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    const pill = createUpdatePill(asElement(host), onClick);
    pill.setVisible(false);
    host.children[0].dispatch('click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('B3 连续点击每次都回调（追平请求由上层做幂等）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    createUpdatePill(asElement(host), onClick);
    for (let i = 0; i < 5; i++) host.children[0].dispatch('click');
    expect(onClick).toHaveBeenCalledTimes(5);
  });
});

// ───────────────────────── C 释放 ─────────────────────────

describe('createUpdatePill / C 释放', () => {
  it('C1 dispose 移除 DOM 节点并注销点击监听', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    const pill = createUpdatePill(asElement(host), onClick);
    const pillEl = host.children[0];
    expect(pillEl.listenerCount('click')).toBe(1);
    pill.dispose();
    expect(host.children).toHaveLength(0);
    expect(pillEl.listenerCount('click')).toBe(0);
    pillEl.dispatch('click');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('C2 dispose 之后 setVisible 不再影响 host（节点已摘除）', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createUpdatePill(asElement(host), () => {});
    pill.dispose();
    expect(() => pill.setVisible(true, '文案')).not.toThrow();
    expect(host.children).toHaveLength(0);
  });

  it('C3 dispose 幂等：重复调用不抛错', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const pill = createUpdatePill(asElement(host), () => {});
    expect(() => { pill.dispose(); pill.dispose(); }).not.toThrow();
    expect(host.children).toHaveLength(0);
  });
});

// ───────────────────────── D host=false 的空实现 ─────────────────────────

describe('createUpdatePill / D host=false 的空实现', () => {
  it('D1 不创建任何 DOM，方法均为空操作', () => {
    const onClick = vi.fn();
    const pill = createUpdatePill(false, onClick);
    expect(() => pill.setVisible(true, '文案')).not.toThrow();
    expect(() => pill.setVisible(false)).not.toThrow();
    expect(() => { pill.dispose(); pill.dispose(); }).not.toThrow();
    expect(onClick).not.toHaveBeenCalled();
  });
});
