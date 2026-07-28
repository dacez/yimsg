import { describe, expect, it, vi } from 'vitest';
import { createUpdatePill } from '../../../src/app/bounded-list/update-pill';
import { FakeDocument, asElement } from './fake-dom';

describe('createUpdatePill', () => {
  it('挂载到 host 下，默认隐藏，setVisible 控制显隐与文案', () => {
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
    // 不传 text 时保留上次文案
    expect(host.children[0].textContent).toBe('有新消息');
  });

  it('点击提示条触发 onClick', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    createUpdatePill(asElement(host), onClick);
    host.children[0].dispatch('click');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('dispose 移除 DOM 节点并注销点击监听', () => {
    const doc = new FakeDocument();
    const host = doc.createElement();
    const onClick = vi.fn();
    const pill = createUpdatePill(asElement(host), onClick);
    const pillEl = host.children[0];
    pill.dispose();
    expect(host.children).toHaveLength(0);
    pillEl.dispatch('click'); // 节点已摘除监听，即使还有引用也不应再触发
    expect(onClick).not.toHaveBeenCalled();
  });

  it('host 为 false 时不创建任何 DOM，方法均为空操作', () => {
    const onClick = vi.fn();
    const pill = createUpdatePill(false, onClick);
    expect(() => pill.setVisible(true, '文案')).not.toThrow();
    pill.dispose();
  });
});
