import { LINE_TAX, SUPPORTED_ORDER_CREATE_VERSIONS, TAX_ROUNDING } from '../versions'

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
