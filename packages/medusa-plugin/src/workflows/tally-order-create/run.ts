import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import type { OrderCreatePayloadV3 } from './fiscal-figures'
import { currencyDecimals, majorToMinor, minorToMajor } from './money'
import { planOrderCreate, totalWarnings } from './plan'
import { resumeOrderCreate } from './resume'
import { mergeStockTopUps, planStockTopUp } from './stock'
import { StoreConfigurationError } from './store-configuration-error'
import { tallyOrderCreateWorkflow, type StockTopUp } from './workflow'

export type TallyPluginOptions = {
  salesChannelId?: string; locationId?: string; shippingOptionId?: string
  // Opt in to the experimental product change journal; disabled by default.
  experimentalSync?: boolean
}

export async function runOrderCreate(
  container: MedusaContainer,
  command: CommandEnvelope<OrderCreatePayload>,
  options: TallyPluginOptions = {},
  ledger?: { claimToken: string; carriedTopUps: StockTopUp[] }
): Promise<CommandResult> {
  const payload = command.payload
  const v3 = payload as OrderCreatePayloadV3
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const existing = await knex('order').select('id', 'status')
    .whereRaw("metadata->>'tally_client_id' = ?", [payload.clientOrderId])
    .whereNull('deleted_at').whereNot('status', 'canceled').first()
  let orderId = existing?.id
  let stockWarnings: ReturnType<typeof planStockTopUp>['warnings'] = []
  if (existing?.status !== 'completed') {
    // An existing order may already be paid, so its configuration failures stay transient (ADR 0004).
    const configurationError = (message: string) =>
      existing ? new Error(message) : new StoreConfigurationError(message)
    const { data: stores } = await query.graph({ entity: 'store', fields: ['default_sales_channel_id'] })
    const salesChannelId = options.salesChannelId ?? stores[0]?.default_sales_channel_id
    const { data: channels } = await query.graph({
      entity: 'sales_channels', fields: ['id', 'stock_locations.id', 'stock_locations.address.*'],
      filters: { id: salesChannelId ?? [] },
    })
    if (!channels[0]) {
      throw configurationError('Missing sales channel; set plugin option salesChannelId')
    }
    const locationId = payload.locationId ?? options.locationId ?? channels[0].stock_locations?.[0]?.id
    const { data: locations } = await query.graph({
      entity: 'stock_location', fields: ['id', 'address.*'], filters: { id: locationId ?? [] },
    })
    const location = locations[0]
    if (!location?.address) {
      throw configurationError('Missing stock location or address; set plugin option locationId')
    }
    const { data: shippingVariants } = await query.graph({
      entity: 'product_variant', fields: ['id', 'product.shipping_profile.id'],
      filters: { id: payload.lines.map(line => line.variantId) },
    })
    const profileIds = [...new Set(shippingVariants.flatMap(variant =>
      variant.product?.shipping_profile?.id ? [variant.product.shipping_profile.id] : []
    ))]
    if (profileIds.length > 1) {
      throw configurationError(`This sale's products use several shipping profiles (${profileIds.join(', ')}); POS sales need one profile per sale, so put these products on one shipping profile`)
    }
    const profileId = profileIds[0]
    const { data: shippingOptions } = await query.graph({
      entity: 'shipping_option', fields: ['id', 'created_at', 'shipping_profile_id', 'service_zone.fulfillment_set.location.id'],
    })
    let shippingOptionId = options.shippingOptionId
    if (shippingOptionId) {
      const option = shippingOptions.find(option => option.id === shippingOptionId)
      if (option && profileId && option.shipping_profile_id !== profileId) {
        throw configurationError(`Shipping option ${shippingOptionId} (plugin option shippingOptionId) uses shipping profile ${option.shipping_profile_id}, but the sale's products use ${profileId}`)
      }
    } else {
      const locationOptions = shippingOptions.filter(option => option.service_zone?.fulfillment_set?.location?.id === location.id)
      if (!locationOptions.length) {
        throw configurationError('Missing shipping option; set plugin option shippingOptionId')
      }
      // Medusa createOrderFulfillmentWorkflow rejects shipped items whose product profile differs from the option's.
      shippingOptionId = locationOptions.filter(option => !profileId || option.shipping_profile_id === profileId)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0]?.id
      if (!shippingOptionId) {
        throw configurationError(`No shipping option at stock location ${location.id} uses shipping profile ${profileId}; add one, or set plugin option shippingOptionId`)
      }
    }
    if (orderId) {
      await resumeOrderCreate(container, orderId, Number(minorToMajor(payload.totalMinor, currencyDecimals(payload.currency))),
        locationId, shippingOptionId)
    } else {
      const { data: regions } = await query.graph({ entity: 'region', fields: ['id', 'currency_code', 'countries.iso_2'] })
      const matchingRegions = regions.filter(region => region.currency_code.toLowerCase() === payload.currency.toLowerCase())
      const region = matchingRegions.find(region => region.countries?.some(
        country => country.iso_2.toLowerCase() === location.address.country_code.toLowerCase()
      )) ?? matchingRegions[0]
      const { data: variants } = await query.graph({
        entity: 'product_variant', fields: ['id', 'manage_inventory', 'allow_backorder',
          'inventory_items.inventory_item_id', 'inventory_items.required_quantity'],
        filters: { id: payload.lines.map(line => line.variantId) },
      })
      const { address_1, address_2, city, country_code, province, postal_code, phone } = location.address
      const customerId = v3.customer?.customerId
      const customer = customerId === undefined ? null : (await query.graph({
        entity: 'customer', fields: ['id'], filters: { id: customerId },
      })).data[0] ?? null
      const planned = planOrderCreate(payload, {
        customer,
        commandId: command.id, salesChannelId: channels[0].id,
        location: { id: location.id, address: { address_1, address_2, city, country_code, province, postal_code, phone } },
        region: region ? {
          id: region.id, currency_code: region.currency_code, country_codes: region.countries.map(country => country.iso_2),
        } : { id: '', currency_code: '', country_codes: [] },
        variants: Object.fromEntries(variants.map(variant => [variant.id, { id: variant.id }])),
      })
      if (planned.ok === false) return { id: command.id, status: 'rejected', error: planned.rejection }
      const { data: levels } = await query.graph({
        entity: 'inventory_level', fields: ['inventory_item_id', 'location_id', 'stocked_quantity', 'reserved_quantity'],
        filters: { inventory_item_id: variants.flatMap(variant => variant.inventory_items.map(item => item.inventory_item_id)), location_id: location.id },
      })
      const stock = planStockTopUp(payload.lines, variants.map(variant => ({
        variantId: variant.id, manageInventory: variant.manage_inventory,
        items: variant.inventory_items.map(item => ({ inventoryItemId: item.inventory_item_id, requiredQuantity: Number(item.required_quantity) })),
      })), levels.map(level => ({ inventoryItemId: level.inventory_item_id, stocked: Number(level.stocked_quantity), reserved: Number(level.reserved_quantity) })))
      const topUps = mergeStockTopUps(ledger?.carriedTopUps ?? [], stock.topUps.map(topUp => ({
        inventory_item_id: topUp.inventoryItemId, location_id: location.id, shortfall: topUp.shortfall,
      })))
      if (topUps.length) planned.plan.draftOrder.metadata.tally_stock_topups = topUps
      try {
        const { result } = await tallyOrderCreateWorkflow(container).run({ input: {
          ledger: ledger ? { commandId: command.id, claimToken: ledger.claimToken } : null, carriedTopUps: ledger?.carriedTopUps ?? [],
          draftOrder: planned.plan.draftOrder, paymentAmount: Number(planned.plan.paymentAmount),
          locationId: planned.plan.locationId, shippingOptionId, stockTopUps: stock.topUps, missingLevels: stock.missingLevels,
        } })
        orderId = result.orderId
      } catch (error) {
        throw error
      }
    }
  }
  const { data: [order] } = await query.graph({
    entity: 'order', fields: ['id', 'display_id', 'total', 'raw_total', 'metadata'], filters: { id: orderId },
  })
  if (order.metadata?.tally_stock_topups) {
    const topUps = order.metadata.tally_stock_topups as StockTopUp[]
    const { data: variants } = await query.graph({
      entity: 'product_variant', fields: ['id', 'manage_inventory', 'inventory_items.inventory_item_id', 'inventory_items.required_quantity'],
      filters: { id: payload.lines.map(line => line.variantId) },
    })
    stockWarnings = variants.filter(variant => variant.manage_inventory).flatMap(variant => {
      const quantity = Math.max(0, ...variant.inventory_items.map(item => Math.ceil(
        (topUps.find(topUp => topUp.inventory_item_id === item.inventory_item_id)?.shortfall ?? 0) / Number(item.required_quantity)
      )))
      return quantity > 0 ? [{ code: 'insufficient_stock' as const, variantId: variant.id, quantity }] : []
    })
  }
  const serverMinor = majorToMinor(order.raw_total.value, currencyDecimals(payload.currency))
  const warnings = [...totalWarnings(payload.totalMinor, serverMinor), ...stockWarnings]
  return {
    id: command.id, status: 'applied',
    serverRefs: { orderId: order.id, displayId: String(order.display_id), totalMinor: serverMinor },
    ...(warnings.length ? { warnings } : {}),
  }
}
