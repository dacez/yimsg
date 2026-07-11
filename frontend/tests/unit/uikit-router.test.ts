import { describe, expect, it } from 'vitest';
import {
  parseRoute,
  routeNamespaceFor,
  routeToHash,
} from '../../src/uikit/app/router';

describe('UIKit hash router（独立主应用，namespace = null）', () => {
  it('解析一级导航路由', () => {
    expect(parseRoute('#/contacts', null)).toEqual({ view: 'contacts' });
    expect(parseRoute('#/settings', null)).toEqual({ view: 'settings' });
    expect(parseRoute('', null)).toEqual({ view: 'chat' });
  });

  it('解析会话深链', () => {
    expect(parseRoute('#/chat/u/200', null)).toEqual({ view: 'chat', conversation: { toUid: '200' } });
    expect(parseRoute('#/chat/g/500', null)).toEqual({ view: 'chat', conversation: { groupId: '500' } });
  });

  it('序列化路由时会编码动态片段', () => {
    expect(routeToHash({ view: 'chat', conversation: { toUid: 'u/1' } }, null)).toBe('#/chat/u/u%2F1');
    expect(routeToHash({ view: 'settings' }, null)).toBe('#/settings');
  });
});

describe('UIKit hash router（嵌入式 widget，namespace = instanceId）', () => {
  it('只认领带自己 instanceId 前缀的 hash', () => {
    expect(parseRoute('#/kf3/chat/u/200', 'kf3')).toEqual({ view: 'chat', conversation: { toUid: '200' } });
    expect(parseRoute('#/kf3/contacts', 'kf3')).toEqual({ view: 'contacts' });
    expect(parseRoute('#/kf3', 'kf3')).toEqual({ view: 'chat' });
  });

  it('同页其它 widget 或宿主页面触发的 hash 变化一律视为不是发给自己的，返回 null', () => {
    // 同页另一个 widget（不同 instanceId）触发的 hash 变化。
    expect(parseRoute('#/kf5/chat/u/999', 'kf3')).toBeNull();
    // 宿主页面 / 独立主应用风格的无前缀 hash，不应被误当作发给某个具体 widget。
    expect(parseRoute('#/chat/u/999', 'kf3')).toBeNull();
    expect(parseRoute('', 'kf3')).toBeNull();
  });

  it('序列化路由会带上 instanceId 前缀', () => {
    expect(routeToHash({ view: 'chat', conversation: { toUid: '200' } }, 'kf3')).toBe('#/kf3/chat/u/200');
    expect(routeToHash({ view: 'settings' }, 'kf3')).toBe('#/kf3/settings');
  });

  it('routeNamespaceFor：独立主应用不加命名空间，嵌入式 widget 用自己的 instanceId', () => {
    expect(routeNamespaceFor({ embedded: false, instanceId: 'default' })).toBeNull();
    expect(routeNamespaceFor({ embedded: true, instanceId: 'kf3' })).toBe('kf3');
  });
});
