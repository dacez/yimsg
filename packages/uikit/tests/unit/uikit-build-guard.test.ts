import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readUikitConfig(): string {
  return readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
}

describe('UIKit 构建护栏', () => {
  it('同时发布 ESM 与 IIFE，第三方站点可直接用 script 标签引入', () => {
    const config = readUikitConfig();
    expect(config).toContain("formats: ['es', 'iife']");
    // IIFE 产物挂到全局 YimsgUIKit，宿主页不需要改造成 module script。
    expect(config).toContain("name: 'YimsgUIKit'");
    expect(config).toContain('yimsg-uikit.iife.js');
  });

  it('构建脚本会把 EMPTY_IMPORT_META 视为失败', () => {
    // IIFE 下 import.meta 为空，任何据此定位资源的代码都会静默失效；
    // 这条护栏保证源码一旦引入 import.meta.url，构建立刻红。
    const config = readUikitConfig();
    expect(config).toContain('EMPTY_IMPORT_META');
    expect(config).toContain('throw new Error');
  });
});
