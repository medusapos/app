import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError } from '@medusajs/framework/utils'
import { deleteDraftOrdersWorkflow } from '@medusajs/medusa/core-flows'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core'
import { currencyDecimals, majorToMinor } from './money'
import { planOrderCreate, totalWarnings } from './plan'
import { tallyOrderCreateWorkflow } from './workflow'

export type TallyPluginOptions = { salesChannelId?: string; locationId?: string; shippingOptionId?: string }

export async function runOrderCreate(
  container: MedusaContainer,
  command: CommandEnvelope<OrderCreatePayload>,
  options: TallyPluginOptions = {}
): Promise<CommandResult> {
  const payload = command.payload
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const existing = await knex('order').select('id', 'is_draft_order')
    .whereRaw("metadata->>'tally_client_id' = ?", [payload.clientOrderId])
    .whereNull('deleted_at').whereNot('status', 'canceled').first()
  let orderId = existing?.id
  if (existing?.is_draft_order) {
    await deleteDraftOrdersWorkflow(container).run({ input: { order_ids: [existing.id] } })
    orderId = undefined
  }
  if (!orderId) {
    const { data: stores } = await query.graph({ entity: 'store', fields: ['default_sales_channel_id'] })
    const salesChannelId = options.salesChannelId ?? stores[0]?.default_sales_channel_id
    const { data: channels } = await query.graph({
      entity: 'sales_channels', fields: ['id', 'stock_locations.id', 'stock_locations.address.*'],
      filters: { id: salesChannelId ?? [] },
    })
    if (!channels[0]) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Missing sales channel; set plugin option salesChannelId')
    }
    const locationId = payload.locationId ?? options.locationId ?? channels[0].stock_locations?.[0]?.id
    const { data: locations } = await query.graph({
      entity: 'stock_location', fields: ['id', 'address.*'], filters: { id: locationId ?? [] },
    })
    const location = locations[0]
    if (!location?.address) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Missing stock location or address; set plugin option locationId')
    }
    const { data: regions } = await query.graph({ entity: 'region', fields: ['id', 'currency_code', 'countries.iso_2'] })
    const matchingRegions = regions.filter(region => region.currency_code.toLowerCase() === payload.currency.toLowerCase())
    const region = matchingRegions.find(region => region.countries?.some(
      country => country.iso_2.toLowerCase() === location.address.country_code.toLowerCase()
    )) ?? matchingRegions[0]
    const { data: variants } = await query.graph({
      entity: 'product_variant', fields: ['id'], filters: { id: payload.lines.map(line => line.variantId) },
    })
    let shippingOptionId = options.shippingOptionId
    if (!shippingOptionId) {
      const { data: shippingOptions } = await query.graph({
        entity: 'shipping_option', fields: ['id', 'created_at', 'service_zone.fulfillment_set.location.id'],
      })
      shippingOptionId = shippingOptions.filter(option => option.service_zone?.fulfillment_set?.location?.id === location.id)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0]?.id
    }
    if (!shippingOptionId) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Missing shipping option; set plugin option shippingOptionId')
    }
    const { address_1, address_2, city, country_code, province, postal_code, phone } = location.address
    const planned = planOrderCreate(payload, {
      commandId: command.id, salesChannelId: channels[0].id,
      location: { id: location.id, address: { address_1, address_2, city, country_code, province, postal_code, phone } },
      region: region ? {
        id: region.id, currency_code: region.currency_code, country_codes: region.countries.map(country => country.iso_2),
      } : { id: '', currency_code: '', country_codes: [] },
      variants: Object.fromEntries(variants.map(variant => [variant.id, { id: variant.id }])),
    })
    if (planned.ok === false) return { id: command.id, status: 'rejected', error: planned.rejection }
    try {
      const { result } = await tallyOrderCreateWorkflow(container).run({ input: {
        draftOrder: planned.plan.draftOrder, paymentAmount: Number(planned.plan.paymentAmount),
        locationId: planned.plan.locationId, shippingOptionId,
      } })
      orderId = result.orderId
    } catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.NOT_ALLOWED && (
        error.code === 'INSUFFICIENT_INVENTORY' || error.message.includes('does not have the required inventory') ||
        error.message.includes('Not enough stock')
      )) {
        return { id: command.id, status: 'rejected', error: { code: 'insufficient_stock', message: error.message } }
      }
      throw error
    }
  }
  const { data: [order] } = await query.graph({
    entity: 'order', fields: ['id', 'display_id', 'total', 'raw_total'], filters: { id: orderId },
  })
  const serverMinor = majorToMinor(order.raw_total.value, currencyDecimals(payload.currency))
  const warnings = totalWarnings(payload.totalMinor, serverMinor)
  return {
    id: command.id, status: 'applied',
    serverRefs: { orderId: order.id, displayId: String(order.display_id), totalMinor: serverMinor },
    ...(warnings.length ? { warnings } : {}),
  }
}
