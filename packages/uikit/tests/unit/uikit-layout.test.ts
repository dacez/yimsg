import { describe, expect, it } from 'vitest';
import {
  EMBEDDED_WIDGET_MIN_HEIGHT,
  EMBEDDED_WIDGET_MIN_WIDTH,
  MOBILE_LAYOUT_MAX_WIDTH,
  detectResponsiveLayout,
  isEmbeddedWidgetTooSmall,
  resolveResponsiveLayout,
} from '../../src/responsive-layout';

describe('uikit responsive layout', () => {
  it('在窄容器下自动切换为 mobile', () => {
    expect(detectResponsiveLayout({ width: MOBILE_LAYOUT_MAX_WIDTH - 1 })).toBe('mobile');
  });

  it('在等于阈值时仍视为 mobile', () => {
    expect(detectResponsiveLayout({ width: MOBILE_LAYOUT_MAX_WIDTH })).toBe('mobile');
  });

  it('粗指针设备会优先切到 mobile', () => {
    expect(detectResponsiveLayout({
      width: 1200,
      matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
    })).toBe('mobile');
  });

  it('显式 desktop/mobile 选择会覆盖自动判定', () => {
    const env = { width: 320, matchMedia: () => ({ matches: true }) };
    expect(resolveResponsiveLayout('desktop', env)).toBe('desktop');
    expect(resolveResponsiveLayout('mobile', env)).toBe('mobile');
  });

  it('容器宽度缺失时回退到视口宽度', () => {
    expect(resolveResponsiveLayout('auto', { innerWidth: 1024 })).toBe('desktop');
    expect(resolveResponsiveLayout('auto', { innerWidth: 375 })).toBe('mobile');
  });

  it('同时给定容器宽度和视口宽度时优先使用容器宽度', () => {
    expect(resolveResponsiveLayout('auto', {
      width: MOBILE_LAYOUT_MAX_WIDTH - 1,
      innerWidth: 1280,
    })).toBe('mobile');
    expect(resolveResponsiveLayout('auto', {
      width: MOBILE_LAYOUT_MAX_WIDTH + 1,
      innerWidth: 375,
    })).toBe('desktop');
  });

  it('缺少宽度信息且不是粗指针设备时默认 desktop', () => {
    expect(detectResponsiveLayout({})).toBe('desktop');
  });

  it('嵌入宿主尺寸小于最小值时显示尺寸保护态', () => {
    expect(isEmbeddedWidgetTooSmall({ width: EMBEDDED_WIDGET_MIN_WIDTH - 1, height: EMBEDDED_WIDGET_MIN_HEIGHT })).toBe(true);
    expect(isEmbeddedWidgetTooSmall({ width: EMBEDDED_WIDGET_MIN_WIDTH, height: EMBEDDED_WIDGET_MIN_HEIGHT - 1 })).toBe(true);
  });

  it('嵌入宿主达到最小尺寸时允许显示完整界面', () => {
    expect(isEmbeddedWidgetTooSmall({ width: EMBEDDED_WIDGET_MIN_WIDTH, height: EMBEDDED_WIDGET_MIN_HEIGHT })).toBe(false);
    expect(isEmbeddedWidgetTooSmall({ width: EMBEDDED_WIDGET_MIN_WIDTH + 40, height: EMBEDDED_WIDGET_MIN_HEIGHT + 40 })).toBe(false);
  });
});
