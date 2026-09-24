import { describe, expect, it } from 'vitest';
import { formatDate } from './format-date';

describe('formatDate', () => {
  it('formats a valid date in the local locale', () => {
    const value = '2026-09-24T12:30:00Z';
    expect(formatDate(value)).toBe(new Date(value).toLocaleString());
  });
  it('preserves an invalid value', () => {
    expect(formatDate('corrupt date')).toBe('corrupt date');
  });
  it.each([undefined, null, ''])('returns an empty string for %s', (value) => {
    expect(formatDate(value)).toBe('');
  });
});
