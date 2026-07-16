import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('UIKit 构建护栏', () => {
  it('UIKit 库构建只发布 ESM，避免 IIFE import.meta 高风险产物', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toContain("formats: ['es']");
    expect(config).not.toContain('iife');
  });

  it('构建脚本会把 EMPTY_IMPORT_META 视为失败', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('EMPTY_IMPORT_META');
    expect(config).toContain('throw new Error');
  });
});
