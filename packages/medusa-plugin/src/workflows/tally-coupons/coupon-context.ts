import type { ComputeActionContext, MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MathBN, Modules } from '@medusajs/framework/utils'
import { currencyDecimals, minorToMajor } from '../tally-order-create/money'
import type { TallyPluginOptions } from '../tally-order-create/run'

export type CouponLine = {
  lineId: string; variantId?: string; quantity: number
  taxInclusive: boolean
  netMinor: number
  taxRatePpm?: number
}
export type CouponSale = { currency: string; locationId?: string; customerId?: string; lines: CouponLine[] }
export type CouponContext = { currency: string; decimals: number; lines: Array<CouponLine & { taxRatePpm: number }>; compute: ComputeActionContext }

export async function buildCouponContext(
  container: MedusaContainer, options: TallyPluginOptions, sale: CouponSale,
): Promise<CouponContext> {
  const currency = sale.currency.toLowerCase()
  const decimals = currencyDecimals(currency)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: stores } = await query.graph({ entity: 'store', fields: ['default_sales_channel_id'] })
  const salesChannelId = options.salesChannelId ?? stores[0]?.default_sales_channel_id
  const { data: channels } = await query.graph({
    entity: 'sales_channels', fields: ['id', 'stock_locations.id'], filters: { id: salesChannelId ?? [] },
  })
  const locationId = sale.locationId ?? options.locationId ?? channels[0]?.stock_locations?.[0]?.id
  const { data: locations } = await query.graph({
    entity: 'stock_location', fields: ['id', 'address.country_code', 'address.province'], filters: { id: locationId ?? [] },
  })
  const country = locations[0]?.address?.country_code?.toLowerCase()
  const { data: regions } = await query.graph({ entity: 'region', fields: ['id', 'currency_code', 'countries.iso_2'] })
  const matchingRegions = regions.filter(region => region.currency_code.toLowerCase() === currency)
  const region = matchingRegions.find(region => region.countries?.some(
    countryEntry => countryEntry.iso_2.toLowerCase() === country,
  )) ?? matchingRegions[0]
  const { data: customers } = await query.graph({
    entity: 'customer', fields: ['id', 'email', 'groups.id'], filters: { id: sale.customerId ?? [] },
  })
  const customer = customers[0]
  const { data: variants } = await query.graph({
    entity: 'product_variant', fields: ['id', 'product.id', 'product.discountable', 'product.collection_id',
      'product.type_id', 'product.tags.id', 'product.categories.id'],
    filters: { id: sale.lines.flatMap(line => line.variantId ? [line.variantId] : []) },
  })
  const unresolved = sale.lines.filter(line => line.taxRatePpm === undefined)
  const taxLines = country && unresolved.length ? await container.resolve(Modules.TAX).getTaxLines(
    unresolved.map(line => {
      const product = variants.find(variant => variant.id === line.variantId)?.product
      return {
        id: line.lineId, product_id: product?.id as string, product_type_id: product?.type_id ?? undefined,
        quantity: line.quantity, unit_price: MathBN.div(minorToMajor(line.netMinor, decimals), line.quantity),
        currency_code: currency,
      }
    }),
    { address: { country_code: country, province_code: locations[0]?.address?.province ?? null } },
  ) : []
  const lines = sale.lines.map(line => ({
    ...line,
    taxRatePpm: line.taxRatePpm ?? Math.round(taxLines.filter(
      taxLine => 'line_item_id' in taxLine && taxLine.line_item_id === line.lineId,
    ).reduce((sum, taxLine) => sum + taxLine.rate, 0) * 10000),
  }))
  const compute: ComputeActionContext = {
    currency_code: currency,
    ...(channels[0] ? { sales_channel_id: channels[0].id } : {}),
    ...(country ? { shipping_address: { country_code: country } } : {}),
    ...(region ? { region: { id: region.id } } : {}),
    ...(customer ? { customer: { id: customer.id, groups: customer.groups?.map(group => ({ id: group.id })) ?? [] },
      ...(customer.email ? { email: customer.email } : {}) } : {}),
    items: lines.map(line => {
      const product = variants.find(variant => variant.id === line.variantId)?.product
      const amount = minorToMajor(line.netMinor, decimals)
      const ratio = MathBN.add(1, MathBN.div(line.taxRatePpm, 1000000))
      return {
        id: line.lineId, quantity: line.quantity, is_discountable: product?.discountable ?? true,
        ...(product ? { product: {
          id: product.id, collection_id: product.collection_id ?? undefined, type_id: product.type_id ?? undefined,
          tags: product.tags?.map(tag => ({ id: tag.id })) ?? [],
          categories: product.categories?.map(category => ({ id: category.id })) ?? [],
        } } : {}),
        adjustments: [],
        subtotal: line.taxInclusive ? MathBN.div(amount, ratio) : amount,
        original_total: line.taxInclusive ? amount : MathBN.mult(amount, ratio),
      }
    }),
  }
  return { currency, decimals, lines, compute }
}
