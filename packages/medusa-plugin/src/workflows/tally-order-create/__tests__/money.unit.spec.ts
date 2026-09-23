import { currencyDecimals, majorToMinor, minorToMajor } from '../money'

it.each([['EUR', 2], ['JPY', 0], ['BHD', 3], ['eur', 2]] as const)(
  'uses the currency exponent for %s', (currency, decimals) => {
    expect(currencyDecimals(currency)).toBe(decimals)
  }
)

it('throws for a currency code Intl rejects', () => {
  expect(() => currencyDecimals('BOGUS')).toThrow()
})

it.each([
  [850, 2, '8.50'], [5, 2, '0.05'], [1000, 0, '1000'], [-5, 2, '-0.05'],
  [0, 2, '0.00'], [0, 0, '0'], [Number.MAX_SAFE_INTEGER, 3, '9007199254740.991'],
])('converts %s minor units at exponent %s to %s', (minor, decimals, expected) => {
  expect(minorToMajor(minor as number, decimals as number)).toBe(expected)
})

it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe minor amount %s', minor => {
  expect(() => minorToMajor(minor, 2)).toThrow()
})

it.each([
  ['3.094', 2, 309], ['3.095', 2, 310], ['10', 2, 1000], ['-0.005', 2, -1],
  ['8.5', 2, 850], ['0', 2, 0], ['1.2e-7', 2, 0],
  ['12345678901234.565', 2, 1234567890123457],
  ['-12345678901234.565', 2, -1234567890123457],
  ['12345678901234.564999', 2, 1234567890123456],
  ['-3.094', 2, -309], ['-3.095', 2, -310], ['5e-3', 2, 1], ['-5E-3', 2, -1],
  ['1.2e+3', 2, 120000], ['1.5', 0, 2], ['-1.5', 0, -2], ['0.0005', 3, 1],
  [8.5, 2, 850], [3.095, 2, 310], [-0.005, 2, -1], [1.2e-7, 2, 0], [0, 2, 0],
] as const)('rounds %s major units at exponent %s to %s', (value, decimals, expected) => {
  expect(majorToMinor(value, decimals)).toBe(expected)
})

it.each([NaN, Infinity, -Infinity, 'NaN', 'abc', '', '9007199254740992'])(
  'rejects invalid or unsafe major amount %s', value => {
    expect(() => majorToMinor(value, 0)).toThrow()
  }
)

it.each([0, 2, 3])('round trips safe minor amounts at exponent %s', decimals => {
  const amounts = [Number.MIN_SAFE_INTEGER, -1001, -850, -5, -1, 0, 1, 5, 850, 1001, Number.MAX_SAFE_INTEGER]
  for (const minor of amounts) {
    expect(majorToMinor(minorToMajor(minor, decimals), decimals)).toBe(minor)
  }
})
