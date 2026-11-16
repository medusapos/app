import type { RemoteQueryFunction } from '@medusajs/framework/types'
import type { TallyPluginOptions } from './run'

// The sale's sales channel: the plugin option, else the store's default (ruling 19 keeps both paths on one rule).
export async function saleChannelId(
  query: Pick<RemoteQueryFunction, 'graph'>, options: Pick<TallyPluginOptions, 'salesChannelId'>,
): Promise<string | undefined> {
  if (options.salesChannelId != null) return options.salesChannelId
  const { data: stores } = await query.graph({ entity: 'store', fields: ['default_sales_channel_id'] })
  return stores[0]?.default_sales_channel_id
}

// The region a sale is priced in: same currency, preferring one that covers the stock location's country.
export function pickSaleRegion<R extends { currency_code: string; countries?: { iso_2: string }[] | null }>(
  regions: R[], currency: string, countryCode: string | undefined,
): R | undefined {
  const matches = regions.filter(region => region.currency_code.toLowerCase() === currency.toLowerCase())
  return matches.find(region => region.countries?.some(
    country => country.iso_2.toLowerCase() === countryCode?.toLowerCase(),
  )) ?? matches[0]
}
