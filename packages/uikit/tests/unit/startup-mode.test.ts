import { describe, expect, it } from 'vitest';
import {
  needsInitialModeSelection,
  resolveModeAfterAuth,
  shouldResetPersistentStorage,
} from '../../src/app/startup-mode';

describe('startup-mode', () => {
  it('prompts for mode selection whenever token is missing', () => {
    expect(needsInitialModeSelection(null)).toBe(true);
    expect(needsInitialModeSelection('tok123')).toBe(false);
  });

  it('resolves the final mode after auth without prompting again', () => {
    expect(resolveModeAfterAuth('instant')).toBe('instant');
    expect(resolveModeAfterAuth('persistent')).toBe('persistent');
    expect(resolveModeAfterAuth(null)).toBe('instant');
  });

  it('resets persistent storage only when switching persistent users', () => {
    expect(shouldResetPersistentStorage('instant', '100', '200')).toBe(false);
    expect(shouldResetPersistentStorage('persistent', null, '200')).toBe(false);
    expect(shouldResetPersistentStorage('persistent', '200', '200')).toBe(false);
    expect(shouldResetPersistentStorage('persistent', '100', '200')).toBe(true);
  });
});
