import { describe, expect, it } from 'vitest';
import {
  parseRoute,
  routeToHash,
} from '../../src/uikit/app/router';

describe('UIKit hash router', () => {
  it('解析一级导航路由', () => {
    expect(parseRoute('#/contacts')).toEqual({ view: 'contacts' });
    expect(parseRoute('#/settings')).toEqual({ view: 'settings' });
    expect(parseRoute('')).toEqual({ view: 'chat' });
  });

  it('解析会话深链', () => {
    expect(parseRoute('#/chat/u/200')).toEqual({ view: 'chat', conversation: { toUid: '200' } });
    expect(parseRoute('#/chat/g/500')).toEqual({ view: 'chat', conversation: { groupId: '500' } });
  });

  it('序列化路由时会编码动态片段', () => {
    expect(routeToHash({ view: 'chat', conversation: { toUid: 'u/1' } })).toBe('#/chat/u/u%2F1');
    expect(routeToHash({ view: 'settings' })).toBe('#/settings');
  });
});
