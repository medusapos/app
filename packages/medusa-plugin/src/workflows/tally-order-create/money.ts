/** ISO 4217 minor-unit exponent as resolved by Intl (which rejects malformed codes). */
export function currencyDecimals(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!
}

/** Converts a safe integer minor amount to an exact major-unit decimal string. */
export function minorToMajor(minor: number, decimals: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('minor must be a safe integer')
  const sign = minor < 0 ? '-' : ''
  const digits = Math.abs(minor).toString().padStart(decimals + 1, '0')
  return sign + (decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`)
}

/** Rounds a major-unit decimal to minor units, half away from zero, without float scaling. */
export function majorToMinor(value: string | number, decimals: number): number {
  const match = /^([+-]?)(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!match) throw new RangeError('value must be a finite decimal')
  const [, sign, mantissa, exponent = '0'] = match
  const [whole, fraction = ''] = mantissa.split('.')
  const coefficient = BigInt(whole + fraction)
  const shift = BigInt(decimals) + BigInt(exponent) - BigInt(fraction.length)
  let rounded: bigint
  if (shift >= 0n) {
    rounded = coefficient * 10n ** shift
  } else {
    const divisor = 10n ** -shift
    rounded = coefficient / divisor + (coefficient % divisor * 2n >= divisor ? 1n : 0n)
  }
  const minor = Number(sign === '-' ? -rounded : rounded)
  if (!Number.isSafeInteger(minor)) throw new RangeError('minor amount exceeds safe integer range')
  return minor
}
