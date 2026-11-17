import { describe, expect, it } from 'vitest';
import { formatMoney } from '@tallyui/core';
import { currencyFormat, separatorLabel } from '../lib/currency-format';

describe('currencyFormat', () => {
  it('formats US dollars in en-US', () => {
    expect(currencyFormat('usd', 'en-US')).toEqual({
      code: 'USD', symbol: '$', symbolPosition: 'left', thousandsSeparator: ',', decimalSeparator: '.',
      decimals: 2, example: '$1,234.56',
    });
  });

  it('puts the euro on the right in de-DE, with dot groups and a comma decimal', () => {
    const format = currencyFormat('EUR', 'de-DE')!;
    expect(format.symbol).toBe('€');
    expect(format.symbolPosition).toBe('right');
    expect(format.thousandsSeparator).toBe('.');
    expect(format.decimalSeparator).toBe(',');
    expect(format.decimals).toBe(2);
    expect(format.example).toBe(formatMoney({ amount: 123456, currency: 'EUR' }, 'de-DE'));
  });

  it('a zero-decimal currency has no decimal separator', () => {
    const format = currencyFormat('JPY', 'ja-JP')!;
    expect(format.decimals).toBe(0);
    expect(format.decimalSeparator).toBeNull();
    expect(format.thousandsSeparator).toBe(',');
    expect(format.symbolPosition).toBe('left');
  });

  it('fr-FR groups with a space', () => {
    const format = currencyFormat('EUR', 'fr-FR')!;
    expect(separatorLabel(format.thousandsSeparator)).toBe('Space');
    expect(format.decimalSeparator).toBe(',');
    expect(format.symbolPosition).toBe('right');
  });

  it('is null for a missing, empty, XXX or invalid code', () => {
    expect(currencyFormat(undefined)).toBeNull();
    expect(currencyFormat('')).toBeNull();
    expect(currencyFormat('XXX')).toBeNull();
    expect(currencyFormat('NOTACODE')).toBeNull();
  });
});

describe('separatorLabel', () => {
  it('names none and whitespace, and returns anything else as is', () => {
    expect(separatorLabel(null)).toBe('None');
    expect(separatorLabel('')).toBe('None');
    expect(separatorLabel(' ')).toBe('Space');
    expect(separatorLabel(' ')).toBe('Space');
    expect(separatorLabel(' ')).toBe('Space');
    expect(separatorLabel(',')).toBe(',');
  });
});
