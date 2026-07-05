import { describe, expect, it } from 'vitest';
import {
  autoDetectLayout,
  needsInitialModeSelection,
  resolveLayout,
  resolveModeAfterAuth,
  shouldResetPersistentStorage,
} from '../../src/uikit/app/startup-mode';

describe('startup-mode', () => {
  it('prompts for mode selection whenever token is missing', () => {
    expect(needsInitialModeSelection(null)).toBe(true);
    expect(needsInitialModeSelection('tok123')).toBe(false);
  });

  it('resolves the final mode after auth without prompting again', () => {
    expect(resolveModeAfterAuth('memory')).toBe('memory');
    expect(resolveModeAfterAuth('persistent')).toBe('persistent');
    expect(resolveModeAfterAuth(null)).toBe('memory');
  });

  it('resets persistent storage only when switching persistent users', () => {
    expect(shouldResetPersistentStorage('memory', '100', '200')).toBe(false);
    expect(shouldResetPersistentStorage('persistent', null, '200')).toBe(false);
    expect(shouldResetPersistentStorage('persistent', '200', '200')).toBe(false);
    expect(shouldResetPersistentStorage('persistent', '100', '200')).toBe(true);
  });

  describe('layout detection', () => {
    const envDesktop = {
      innerWidth: 1280,
      matchMedia: (_q: string) => ({ matches: false }),
    };
    const envNarrow = {
      innerWidth: 400,
      matchMedia: (_q: string) => ({ matches: false }),
    };
    const envCoarse = {
      innerWidth: 1280,
      matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }),
    };

    it('autoDetectLayout returns mobile when viewport is narrow', () => {
      expect(autoDetectLayout(envNarrow)).toBe('mobile');
    });

    it('autoDetectLayout returns mobile when pointer is coarse', () => {
      expect(autoDetectLayout(envCoarse)).toBe('mobile');
    });

    it('autoDetectLayout returns desktop on wide screen with fine pointer', () => {
      expect(autoDetectLayout(envDesktop)).toBe('desktop');
    });

    it('resolveLayout honors explicit desktop/mobile regardless of viewport', () => {
      expect(resolveLayout('desktop', envNarrow)).toBe('desktop');
      expect(resolveLayout('mobile', envDesktop)).toBe('mobile');
    });

    it('resolveLayout falls through to auto detection when choice is auto', () => {
      expect(resolveLayout('auto', envDesktop)).toBe('desktop');
      expect(resolveLayout('auto', envNarrow)).toBe('mobile');
      expect(resolveLayout('auto', envCoarse)).toBe('mobile');
    });

    it('autoDetectLayout tolerates missing matchMedia / innerWidth', () => {
      expect(autoDetectLayout({})).toBe('desktop');
      expect(autoDetectLayout({ innerWidth: 320 })).toBe('mobile');
    });
  });
});
