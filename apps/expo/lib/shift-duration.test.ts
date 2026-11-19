import { expect, it } from 'vitest';
import { formatShiftDuration } from './shift-duration';

const OPENED = '2026-09-28T08:00:00.000Z';
const at = (seconds: number) => Date.parse(OPENED) + seconds * 1000;

it.each([
  [0, '0 m'],
  [59, '0 m'],
  [45 * 60, '45 m'],
  [59 * 60 + 59, '59 m'],
  [60 * 60, '1 h 0 m'],
  [103 * 60, '1 h 43 m'],
  [125 * 60, '2 h 5 m'],
  [(26 * 60 + 5) * 60, '26 h 5 m'],
])('formats %i s since opening as %s', (seconds, expected) => {
  expect(formatShiftDuration(OPENED, at(seconds))).toBe(expected);
});

it('reads an opening time in the future as 0 m', () => {
  expect(formatShiftDuration(OPENED, at(-90 * 60))).toBe('0 m');
});

it('returns an empty string for an unparsable opening time', () => {
  expect(formatShiftDuration('not a date', at(0))).toBe('');
});
