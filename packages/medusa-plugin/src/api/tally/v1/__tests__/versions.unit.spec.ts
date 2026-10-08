import { approvalThresholdMinor, DEFAULT_APPROVAL_THRESHOLD_MINOR, LINE_TAX, registerVersionAccepted,
  SUPPORTED_ORDER_CREATE_VERSIONS, SUPPORTED_REGISTER_VERSIONS, TAX_ROUNDING } from '../versions'

// The ServerCapabilities.taxRounding contract (TallyUI #309): /info tells the till to round tax the way the store does.
describe('TAX_ROUNDING', () => {
  it('is per order, half away from zero', () => {
    expect(TAX_ROUNDING).toEqual({ granularity: 'per_order', mode: 'half_away_from_zero' })
  })
})

it('order.create versions include 5 and lineTax is { none: false, classes: false }', () => {
  expect(SUPPORTED_ORDER_CREATE_VERSIONS).toEqual([1, 2, 3, 4, 5])
  expect(LINE_TAX).toEqual({ none: false, classes: false })
})

it.each([[undefined, 500], [0, 0], [250, 250], [-1, 500], [1.5, 500], [Infinity, 500], [NaN, 500],
  [Number.MAX_SAFE_INTEGER + 1, 500]])('normalises approval threshold %s to %s', (value, expected) => {
  expect(DEFAULT_APPROVAL_THRESHOLD_MINOR).toBe(500)
  expect(approvalThresholdMinor(value === undefined ? {} : { approvalThresholdMinor: value })).toBe(expected)
})

it('accepts supported register versions, subject to the optional minimum', () => {
  expect(SUPPORTED_REGISTER_VERSIONS).toEqual([1, 2, 3])
  for (const version of [1, 2, 3]) expect(registerVersionAccepted(version, {})).toBe(true)
  for (const version of [1, 2]) expect(registerVersionAccepted(version, { minRegisterContract: 3 })).toBe(false)
  expect(registerVersionAccepted(3, { minRegisterContract: 3 })).toBe(true)
  expect(registerVersionAccepted(4, {})).toBe(false)
  expect(registerVersionAccepted(4, { minRegisterContract: 3 })).toBe(false)
})
