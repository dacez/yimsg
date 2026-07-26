import { describe, expect, it, vi } from 'vitest';
import { ConnectionError, RequestError, ValidationError } from '@yimsg/sdk';
import type { AppInstance } from '../../src/app/app-instance';
import { translations } from '../../src/app/i18n';

function makeApp(lang: 'en' | 'zh' = 'en'): AppInstance {
  const dict = translations[lang] as Record<string, string>;
  return {
    t: (key: string, vars?: Record<string, string | number>) => {
      let text = dict[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(`{${name}}`, String(value));
        }
      }
      return text;
    },
  } as unknown as AppInstance;
}

describe('describeError', () => {
  it('maps a known server error token to localized text via serverErrorCode', async () => {
    const { describeError } = await import('../../src/app/error-i18n');
    const err = new RequestError('REQUEST_FAILED', 'not_a_group_member', {
      details: { serverErrorCode: 'FORBIDDEN' },
    });
    expect(describeError(makeApp('en'), err)).toBe("You're not a member of this group.");
    expect(describeError(makeApp('zh'), err)).toBe('你不是该群成员。');
  });

  it('never surfaces the raw server msg for INTERNAL_ERROR, even if it looks like a stack trace', async () => {
    const { describeError } = await import('../../src/app/error-i18n');
    const err = new RequestError('REQUEST_FAILED', 'sqlite: disk I/O error at row 42', {
      details: { serverErrorCode: 'INTERNAL_ERROR' },
    });
    expect(describeError(makeApp('en'), err)).toBe('Something went wrong on our end. Please try again.');
  });

  it('falls back to a per-category message and warns when the token has no i18n mapping', async () => {
    const { describeError } = await import('../../src/app/error-i18n');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new RequestError('REQUEST_FAILED', 'some_future_unmapped_token', {
      details: { serverErrorCode: 'FORBIDDEN' },
    });
    expect(describeError(makeApp('en'), err)).toBe("You don't have permission to do this.");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('maps SDK-native errors (no serverErrorCode) by YimsgError.code, ignoring the built-in message', async () => {
    const { describeError } = await import('../../src/app/error-i18n');
    const err = new ConnectionError('CONNECTION_FAILED', '连接失败');
    expect(describeError(makeApp('en'), err)).toBe('Connection failed. Please check your network.');
  });

  it('falls back to a generic message for non-YimsgError values', async () => {
    const { describeError } = await import('../../src/app/error-i18n');
    expect(describeError(makeApp('en'), new Error('boom'))).toBe('Something went wrong. Please try again.');
    expect(describeError(makeApp('en'), 'plain string')).toBe('Something went wrong. Please try again.');
  });

  it('uses the ValidationError code fallback when a request-kind error has no serverErrorCode (e.g. upload)', async () => {
    const { describeError } = await import('../../src/app/error-i18n');
    const err = new RequestError('UPLOAD_FAILED', 'network error');
    expect(describeError(makeApp('en'), err)).toBe('Upload failed. Please try again.');
  });

  it('ValidationError (client-side SDK validation) maps by code', async () => {
    const { describeError } = await import('../../src/app/error-i18n');
    const err = new ValidationError('text too long');
    expect(describeError(makeApp('en'), err)).toBe('Invalid input.');
  });
});
