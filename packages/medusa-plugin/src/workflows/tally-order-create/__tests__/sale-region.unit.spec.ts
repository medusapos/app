import { pickSaleRegion, saleChannelId } from '../sale-region'

it('prefers the first country match over an earlier currency-only match', () => {
  const regions = [
    { id: 'other-currency', currency_code: 'usd', countries: [{ iso_2: 'es' }] },
    { id: 'fallback', currency_code: 'eur', countries: [{ iso_2: 'fr' }] },
    { id: 'country-match', currency_code: 'eur', countries: [{ iso_2: 'es' }] },
    { id: 'later-match', currency_code: 'eur', countries: [{ iso_2: 'es' }] },
  ]
  expect(pickSaleRegion(regions, 'eur', 'es')).toBe(regions[2])
  expect(pickSaleRegion(regions, 'eur', 'de')).toBe(regions[1])
})

it.each([
  ['EUR', 'ES', 'eur', 'es'],
  ['eur', 'es', 'EUR', 'ES'],
])('compares currency %s and country %s case-insensitively', (regionCurrency, regionCountry, currency, country) => {
  const regions = [
    { currency_code: regionCurrency, countries: [{ iso_2: 'fr' }] },
    { currency_code: regionCurrency, countries: [{ iso_2: regionCountry }] },
  ]
  expect(pickSaleRegion(regions, currency, country)).toBe(regions[1])
})

it('uses the first currency match when there is no country', () => {
  const regions = [
    { currency_code: 'usd' },
    { currency_code: 'eur' },
    { currency_code: 'eur', countries: [{ iso_2: 'es' }] },
  ]
  expect(pickSaleRegion(regions, 'eur', undefined)).toBe(regions[1])
})

it('returns undefined when no currency matches', () => {
  expect(pickSaleRegion([{ currency_code: 'usd', countries: [{ iso_2: 'es' }] }], 'eur', 'es')).toBeUndefined()
})

it('skips null countries for a country match but allows that region as the fallback', () => {
  const regions = [
    { currency_code: 'eur', countries: null },
    { currency_code: 'eur', countries: [{ iso_2: 'es' }] },
  ]
  expect(pickSaleRegion(regions, 'eur', 'es')).toBe(regions[1])
  expect(pickSaleRegion(regions, 'eur', 'fr')).toBe(regions[0])
})

it.each(['sc_option', ''])('uses the sales channel option %j without querying', async salesChannelId => {
  const query = { graph: jest.fn() }
  expect(await saleChannelId(query, { salesChannelId })).toBe(salesChannelId)
  expect(query.graph).not.toHaveBeenCalled()
})

it('uses the store default sales channel when the option is absent', async () => {
  const query = { graph: jest.fn().mockResolvedValue({ data: [{ default_sales_channel_id: 'sc_default' }] }) }
  expect(await saleChannelId(query, {})).toBe('sc_default')
  expect(query.graph).toHaveBeenCalledTimes(1)
  expect(query.graph).toHaveBeenCalledWith({ entity: 'store', fields: ['default_sales_channel_id'] })
})

it('returns undefined when there is no store row', async () => {
  const query = { graph: jest.fn().mockResolvedValue({ data: [] }) }
  expect(await saleChannelId(query, {})).toBeUndefined()
})
