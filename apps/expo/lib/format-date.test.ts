import { describe, expect, it } from 'vitest';
import { formatDate, formatPaidDate, formatReceiptDate } from './format-date';

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
