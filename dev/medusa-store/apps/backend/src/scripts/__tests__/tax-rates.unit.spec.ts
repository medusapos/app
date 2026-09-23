import { missingDefaultTaxRates } from '../tax-rates'

describe('missingDefaultTaxRates', () => {
  it('creates standard VAT defaults in input order for regions without rates', () => {
    const countries = ['de', 'gb', 'dk', 'se', 'fr', 'es', 'it']
    const input = missingDefaultTaxRates(countries.map((country_code) => ({
      id: `region-${country_code}`, country_code, tax_rates: [],
    })))

    expect(input).toHaveLength(7)
    expect(input[0]).toEqual({
      tax_region_id: 'region-de', rate: 19, code: 'vat-de', name: 'DE VAT', is_default: true,
    })
    expect(input.map(({ tax_region_id }) => tax_region_id)).toEqual(
      countries.map((country) => `region-${country}`)
    )
    expect(input.map(({ rate }) => rate)).toEqual([19, 20, 25, 25, 20, 21, 22])
  })

  it('skips regions that already have a default rate', () => {
    expect(missingDefaultTaxRates([{
      id: 'de', country_code: 'de',
      tax_rates: [{ id: 'reduced', is_default: false }, { id: 'vat', is_default: true }],
    }])).toEqual([])
  })

  it('creates a default when only non-default rates exist', () => {
    expect(missingDefaultTaxRates([{
      id: 'de', country_code: 'de',
      tax_rates: [null, { id: 'reduced', is_default: false }, { id: 'unset', is_default: null }],
    }])).toEqual([{
      tax_region_id: 'de', rate: 19, code: 'vat-de', name: 'DE VAT', is_default: true,
    }])
  })

  it('skips province-level and child regions', () => {
    expect(missingDefaultTaxRates([
      { id: 'province', country_code: 'de', province_code: 'be' },
      { id: 'child', country_code: 'de', parent_id: 'parent' },
    ])).toEqual([])
  })

  it('skips countries outside the map', () => {
    expect(missingDefaultTaxRates([{ id: 'us', country_code: 'us' }])).toEqual([])
  })

  it('normalizes upper-case country codes', () => {
    expect(missingDefaultTaxRates([{ id: 'de', country_code: 'DE' }])).toEqual([{
      tax_region_id: 'de', rate: 19, code: 'vat-de', name: 'DE VAT', is_default: true,
    }])
  })

  it('accepts absent or null rates and null country-level fields', () => {
    expect(missingDefaultTaxRates([
      { id: 'de', country_code: 'de' },
      { id: 'gb', country_code: 'gb', tax_rates: null, parent_id: null, province_code: null },
    ]).map(({ tax_region_id }) => tax_region_id)).toEqual(['de', 'gb'])
  })

  it('creates no additional rates after its defaults have been applied', () => {
    const regions = [{ id: 'de', country_code: 'de' }]
    const defaults = missingDefaultTaxRates(regions)
    expect(missingDefaultTaxRates(regions.map((region, index) => ({
      ...region, tax_rates: [{ id: 'vat', is_default: defaults[index].is_default }],
    })))).toEqual([])
  })
})
