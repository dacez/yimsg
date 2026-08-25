import { describe, expect, it } from 'vitest';
import { needsInitialLayoutSelection } from '../../src/app/startup-mode';

describe('startup-mode', () => {
  it('没有 token 时才需要先确认布局偏好', () => {
    expect(needsInitialLayoutSelection(null)).toBe(true);
    expect(needsInitialLayoutSelection('tok123')).toBe(false);
  });
});
