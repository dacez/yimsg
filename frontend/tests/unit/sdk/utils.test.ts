import { describe, it, expect } from 'vitest';
import { parseConvKey, formatFileSize } from '../../../src/sdk/utils';

describe('parseConvKey', () => {
  it('parses group key', () => {
    expect(parseConvKey('g:123')).toEqual({ isGroup: true, id: '123' });
  });

  it('parses user key', () => {
    expect(parseConvKey('u:456')).toEqual({ isGroup: false, id: '456' });
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('formats KB', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB');
  });

  it('formats MB', () => {
    expect(formatFileSize(1536 * 1024)).toBe('1.5 MB');
  });
});
