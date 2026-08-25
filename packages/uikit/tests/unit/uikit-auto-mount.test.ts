import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autoMountFromScript,
  deriveServerUrlFromScriptSrc,
  readMountOptionsFromScript,
} from '../../src/auto-mount';

/**
 * 一行脚本自动挂载单元测试。
 *
 * 项目未引入 jsdom / happy-dom，真实挂载渲染由 Playwright 覆盖；本文件只在零依赖
 * 下验证地址推导、参数映射，以及「不该挂载时确实不挂载」这几条不会走到 mount()
 * 的分支。
 */

/** 构造一个满足 auto-mount 读取需求的假 script 元素。 */
function fakeScript(attrs: Record<string, string>, src = 'https://im.example.com/uikit/yimsg-uikit.iife.js') {
  return {
    src,
    hasAttribute: (name: string) => name in attrs,
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
  } as unknown as HTMLScriptElement;
}

describe('deriveServerUrlFromScriptSrc', () => {
  it('从 bundle 地址推导出服务端根地址', () => {
    expect(deriveServerUrlFromScriptSrc('https://im.example.com/uikit/yimsg-uikit.iife.js'))
      .toBe('https://im.example.com');
  });

  it('保留部署的路径前缀', () => {
    expect(deriveServerUrlFromScriptSrc('https://host.example/yimsg/uikit/yimsg-uikit.iife.js'))
      .toBe('https://host.example/yimsg');
  });

  it('ESM 产物地址同样适用', () => {
    expect(deriveServerUrlFromScriptSrc('http://127.0.0.1:8080/uikit/yimsg-uikit.js'))
      .toBe('http://127.0.0.1:8080');
  });

  it('不是 /uikit/ 形状时按同目录即根保守处理', () => {
    expect(deriveServerUrlFromScriptSrc('https://cdn.example/libs/yimsg.js'))
      .toBe('https://cdn.example/libs');
  });

  it('空值与非法地址返回空串，交由调用方回退同源默认', () => {
    expect(deriveServerUrlFromScriptSrc('')).toBe('');
    expect(deriveServerUrlFromScriptSrc('   ')).toBe('');
    expect(deriveServerUrlFromScriptSrc('not a url')).toBe('');
  });
});

describe('readMountOptionsFromScript', () => {
  it('未显式配置时用脚本来源推导 serverUrl', () => {
    const options = readMountOptionsFromScript(fakeScript({ 'data-yimsg-auto': '' }));
    expect(options.serverUrl).toBe('https://im.example.com');
  });

  it('data-yimsg-server-url 覆盖推导值', () => {
    const options = readMountOptionsFromScript(
      fakeScript({ 'data-yimsg-server-url': 'https://other.example' }),
    );
    expect(options.serverUrl).toBe('https://other.example');
  });

  it('透传主题、语言、布局、显示范围与 token', () => {
    const options = readMountOptionsFromScript(
      fakeScript({
        'data-yimsg-theme': 'dark',
        'data-yimsg-locale': 'en',
        'data-yimsg-layout': 'mobile',
        'data-yimsg-view-mode': 'chat-only',
        'data-yimsg-token': 'tok-123',
      }),
    );
    expect(options.theme).toBe('dark');
    expect(options.locale).toBe('en');
    expect(options.layout).toBe('mobile');
    expect(options.viewMode).toBe('chat-only');
    expect(options.token).toBe('tok-123');
  });

  it('非法的布局与显示范围被忽略，不透传脏值', () => {
    const options = readMountOptionsFromScript(
      fakeScript({ 'data-yimsg-layout': 'sideways', 'data-yimsg-view-mode': 'nope' }),
    );
    expect(options.layout).toBeUndefined();
    expect(options.viewMode).toBeUndefined();
  });

  it('空白属性值视为未配置', () => {
    const options = readMountOptionsFromScript(fakeScript({ 'data-yimsg-token': '   ' }));
    expect(options.token).toBeUndefined();
  });
});

describe('autoMountFromScript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('没有 data-yimsg-auto 时什么都不做', () => {
    const querySelectorAll = vi.fn(() => []);
    vi.stubGlobal('document', { querySelectorAll });

    expect(autoMountFromScript(fakeScript({}))).toEqual([]);
    // 连容器都不该去查：宿主没声明自动挂载，就不能抢在它的 mount() 之前动手。
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it('找不到容器时不挂载、不抛错，只告警一次', () => {
    vi.stubGlobal('document', { querySelectorAll: () => [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(autoMountFromScript(fakeScript({ 'data-yimsg-auto': '' }))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('默认查找 [data-yimsg-widget]，可用 data-yimsg-target 覆盖', () => {
    const querySelectorAll = vi.fn(() => []);
    vi.stubGlobal('document', { querySelectorAll });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    autoMountFromScript(fakeScript({ 'data-yimsg-auto': '' }));
    expect(querySelectorAll).toHaveBeenLastCalledWith('[data-yimsg-widget]');

    autoMountFromScript(fakeScript({ 'data-yimsg-auto': '', 'data-yimsg-target': '#chat' }));
    expect(querySelectorAll).toHaveBeenLastCalledWith('#chat');
  });
});
