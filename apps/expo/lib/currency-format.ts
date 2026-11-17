import { currencySymbol, formatMoney, minorUnitDigits, moneyFromMajor } from '@tallyui/core';

// How this till formats money for one currency, as TallyUI's formatMoney does (row 15a.4).
export type CurrencyFormat = {
  code: string;
  symbol: string;
  symbolPosition: 'left' | 'right';
  thousandsSeparator: string;
  decimalSeparator: string | null;
  decimals: number;
  example: string;
};

// One amount with a group and a fraction, so every separator part shows up.
const SAMPLE_MAJOR = 1234567.89;
// The example amount shown on Settings.
const EXAMPLE_MAJOR = '1234.56';

export function currencyFormat(currency: string | undefined, locale?: string): CurrencyFormat | null {
  if (!currency) return null;
  const code = currency.toUpperCase();
  if (code === 'XXX') return null;
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale, { style: 'currency', currency: code }).formatToParts(SAMPLE_MAJOR);
  } catch {
    return null;
  }
  const example = formatMoney(moneyFromMajor(EXAMPLE_MAJOR, code)!, locale);
  if (example === undefined) return null;
  const currencyAt = parts.findIndex((part) => part.type === 'currency');
  const integerAt = parts.findIndex((part) => part.type === 'integer');
  return {
    code,
    symbol: currencySymbol(code, locale),
    symbolPosition: currencyAt > integerAt ? 'right' : 'left',
    thousandsSeparator: parts.find((part) => part.type === 'group')?.value ?? '',
    decimalSeparator: parts.find((part) => part.type === 'decimal')?.value ?? null,
    decimals: minorUnitDigits(code),
    example,
  };
}

// A separator as a label: whitespace (incl. U+00A0, U+202F) reads "Space", none reads "None".
export function separatorLabel(separator: string | null): string {
  if (separator === null || separator === '') return 'None';
  if (separator.trim() === '') return 'Space';
  return separator;
}
