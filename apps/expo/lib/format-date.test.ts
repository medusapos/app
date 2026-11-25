import { describe, expect, it } from 'vitest';
import { formatDate, formatDayHeader, formatPaidDate, formatReceiptDate } from './format-date';

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

const time = (date: Date) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date);
const day = (date: Date) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);

describe('formatPaidDate', () => {
  it('reads Today and the short time for an order placed today', () => {
    const order = new Date(2026, 10, 18, 7, 30);
    expect(formatPaidDate(order.toISOString(), new Date(2026, 10, 18, 15, 0))).toBe(`Today · ${time(order)}`);
  });
  it('reads the medium date and short time for an order placed yesterday', () => {
    const order = new Date(2026, 10, 17, 7, 30);
    const text = formatPaidDate(order.toISOString(), new Date(2026, 10, 18, 15, 0));
    expect(text).toBe(`${day(order)} · ${time(order)}`);
    expect(text.startsWith('Today')).toBe(false);
  });
  it('does not read Today for an order just before midnight seen just after', () => {
    const order = new Date(2026, 10, 17, 23, 59);
    expect(formatPaidDate(order.toISOString(), new Date(2026, 10, 18, 0, 1))).toBe(`${day(order)} · ${time(order)}`);
  });
  it('reads Today for an order just after midnight seen late the same day', () => {
    const order = new Date(2026, 10, 18, 0, 1);
    expect(formatPaidDate(order.toISOString(), new Date(2026, 10, 18, 23, 59))).toBe(`Today · ${time(order)}`);
  });
  it('does not read Today for the same day and month a year earlier', () => {
    const order = new Date(2025, 10, 18, 7, 30);
    expect(formatPaidDate(order.toISOString(), new Date(2026, 10, 18, 15, 0))).toBe(`${day(order)} · ${time(order)}`);
  });
  it.each([undefined, null, ''])('returns an empty string for %s', (value) => {
    expect(formatPaidDate(value)).toBe('');
  });
  it('preserves an invalid value', () => {
    expect(formatPaidDate('corrupt date')).toBe('corrupt date');
  });
});

describe('formatReceiptDate', () => {
  it('reads the medium date and short time, never Today', () => {
    const date = new Date();
    const text = formatReceiptDate(date.toISOString());
    expect(text).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date));
    expect(text).not.toContain('Today');
  });
  it.each([undefined, null, ''])('returns an empty string for %s', (value) => {
    expect(formatReceiptDate(value)).toBe('');
  });
  it('preserves an invalid value', () => {
    expect(formatReceiptDate('corrupt date')).toBe('corrupt date');
  });
});

describe('formatDayHeader', () => {
  it('reads Today for any time of the local day', () => {
    const now = new Date(2026, 10, 25, 15, 0);
    expect(formatDayHeader(new Date(2026, 10, 25, 0, 0).toISOString(), now)).toBe('Today');
    expect(formatDayHeader(new Date(2026, 10, 25, 23, 59).toISOString(), now)).toBe('Today');
  });
  it('reads Yesterday for the previous local calendar day, at both its ends', () => {
    const now = new Date(2026, 10, 25, 0, 1);
    expect(formatDayHeader(new Date(2026, 10, 24, 23, 59).toISOString(), now)).toBe('Yesterday');
    expect(formatDayHeader(new Date(2026, 10, 24, 0, 0).toISOString(), now)).toBe('Yesterday');
  });
  it('reads the medium date two days back', () => {
    const order = new Date(2026, 10, 23, 23, 59);
    expect(formatDayHeader(order.toISOString(), new Date(2026, 10, 25, 0, 1))).toBe(day(order));
  });
  it('reads Yesterday across a month and a year end', () => {
    expect(formatDayHeader(new Date(2026, 9, 31, 12, 0).toISOString(), new Date(2026, 10, 1, 9, 0))).toBe('Yesterday');
    expect(formatDayHeader(new Date(2025, 11, 31, 22, 0).toISOString(), new Date(2026, 0, 1, 1, 0))).toBe('Yesterday');
    expect(formatDayHeader(new Date(2026, 1, 28, 12, 0).toISOString(), new Date(2026, 2, 1, 9, 0))).toBe('Yesterday');
  });
  it('reads Yesterday on the morning after a DST change (the local calendar, not 24 hours)', () => {
    // Whatever the test machine's zone, each pair is one calendar day apart; in a DST zone one of them is 23 or 25 hours.
    for (const [then, now] of [[new Date(2026, 2, 28, 23, 30), new Date(2026, 2, 29, 23, 0)],
      [new Date(2026, 9, 24, 23, 30), new Date(2026, 9, 25, 0, 30)], [new Date(2026, 2, 29, 0, 30), new Date(2026, 2, 30, 0, 10)]]) {
      expect(formatDayHeader(then.toISOString(), now)).toBe('Yesterday');
    }
  });
  it('does not read Today or Yesterday for the same days a year earlier', () => {
    const now = new Date(2026, 10, 25, 15, 0);
    for (const order of [new Date(2025, 10, 25, 9, 0), new Date(2025, 10, 24, 9, 0)]) {
      expect(formatDayHeader(order.toISOString(), now)).toBe(day(order));
    }
  });
  it('reads a future day as its date', () => {
    const order = new Date(2026, 10, 26, 9, 0);
    expect(formatDayHeader(order.toISOString(), new Date(2026, 10, 25, 15, 0))).toBe(day(order));
  });
  it('preserves an invalid value and reads empty for none', () => {
    expect(formatDayHeader('corrupt date')).toBe('corrupt date');
    expect(formatDayHeader(undefined)).toBe('');
    expect(formatDayHeader('')).toBe('');
  });
});
