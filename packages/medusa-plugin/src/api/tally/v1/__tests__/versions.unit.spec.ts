import { TAX_ROUNDING } from '../versions'

// The ServerCapabilities.taxRounding contract (TallyUI #309): /info tells the till to round tax the way the store does.
describe('TAX_ROUNDING', () => {
  it('is per order, half away from zero', () => {
    expect(TAX_ROUNDING).toEqual({ granularity: 'per_order', mode: 'half_away_from_zero' })
  })
})
