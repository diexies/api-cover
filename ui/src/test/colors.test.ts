import { describe, it, expect } from 'vitest';
import { hexToRgba } from '../colors';

describe('hexToRgba', () => {
  it('converts 6-char hex to rgba', () => {
    expect(hexToRgba('#a855f7', 0.5)).toBe('rgba(168, 85, 247, 0.5)');
  });

  it('handles hex without leading #', () => {
    expect(hexToRgba('06b6d4', 1)).toBe('rgba(6, 182, 212, 1)');
  });

  it('returns input unchanged when not 6 chars', () => {
    expect(hexToRgba('#abc', 0.5)).toBe('#abc');
  });

  it('formats alpha 0 correctly', () => {
    expect(hexToRgba('#000000', 0)).toBe('rgba(0, 0, 0, 0)');
  });
});
