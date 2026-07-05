import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  normalizeTrustedResourceUrl,
  safeHtml,
  unwrapSafeHtml,
} from '../../src/uikit/app/safe-dom';

describe('UIKit 安全渲染约束', () => {
  it('拒绝 javascript/data 等危险 URL', () => {
    expect(normalizeTrustedResourceUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeTrustedResourceUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('允许相对路径、同源路径与 http(s) 资源', () => {
    expect(normalizeTrustedResourceUrl('/media/a.png')).toBe('/media/a.png');
    expect(normalizeTrustedResourceUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(normalizeTrustedResourceUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });

  it('SafeHtml 只能通过显式包装产生，普通文本默认转义', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(unwrapSafeHtml(safeHtml('<strong>ok</strong>'))).toBe('<strong>ok</strong>');
  });
});
