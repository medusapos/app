import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { escapeLike, normaliseCustomerEmail, pickCustomer } from './customer-email'
import type { OrderCreatePayloadV3 } from './fiscal-figures'
import { currencyDecimals, majorToMinor, minorToMajor } from './money'
import { customerWarnings, figuresWarnings, planOrderCreate, totalWarnings } from './plan'
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
    // Only a live, published product in the sale's channel sells; any other variant is the planner's stored unknown_variant.
    const sellable = (variant: { product?: { status?: string; deleted_at?: unknown; sales_channels?: ({ id: string } | null)[] | null } | null }) =>
      !!variant.product && !variant.product.deleted_at && variant.product.status === 'published' &&
      !!variant.product.sales_channels?.some(channel => channel?.id === channels[0].id)
    const channelLocations = channels[0].stock_locations ?? []
    // A location the till or the operator names must exist and belong to the sale's channel (ruling 19).
    const locationSource = payload.locationId != null ? 'payload.locationId'
      : options.locationId != null ? 'plugin option locationId' : undefined
    const locationId = payload.locationId ?? options.locationId ?? channelLocations[0]?.id
    const { data: locations } = await query.graph({
      entity: 'stock_location', fields: ['id', 'address.*'], filters: { id: locationId ?? [] },
    })
    const location = locations[0]
    if (locationSource && !location) {
      throw configurationError(`${locationSource}: no stock location with this id`)
    }
    if (locationSource && !channelLocations.some(channelLocation => channelLocation?.id === location.id)) {
      throw configurationError(`${locationSource}: this stock location is not assigned to the sale's sales channel`)
    }
    if (!location?.address) {
      throw configurationError(locationSource ? `${locationSource}: this stock location has no address`
        : 'Missing stock location or address; set plugin option locationId')
    }
    const { data: shippingVariants } = await query.graph({
      entity: 'product_variant', fields: ['id', 'product.id', 'product.shipping_profile.id', 'inventory_items.inventory.requires_shipping',
        'product.status', 'product.deleted_at', 'product.sales_channels.id'],
      filters: { id: payload.lines.map(line => line.variantId) },
    })
    // A resumed order's items are fixed, so every line keeps its profile even if its product is no longer sellable.
    const considered = existing ? shippingVariants : shippingVariants.filter(sellable)
    const profileIds = [...new Set(considered.flatMap(variant =>
      variant.product?.shipping_profile?.id ? [variant.product.shipping_profile.id] : []
    ))]
    if (profileIds.length > 1) {
      throw configurationError(`This sale's products use several shipping profiles (${profileIds.join(', ')}); POS sales need one profile per sale, so put these products on one shipping profile`)
    }
    // Medusa 2.21 ships a line whose product has a profile or whose inventory requires shipping (prepare-line-item-data.js:23-29).
    const unprofiled = considered.find(variant => !variant.product?.shipping_profile?.id &&
      variant.inventory_items?.some(item => item?.inventory?.requires_shipping))
    if (unprofiled) {
      throw configurationError(`Product ${unprofiled.product?.id} (variant ${unprofiled.id}) requires shipping but has no shipping profile; put it on a shipping profile`)
    }
    const profileId = profileIds[0]
    const { data: shippingOptions } = await query.graph({
      entity: 'shipping_option', fields: ['id', 'created_at', 'shipping_profile_id', 'service_zone.fulfillment_set.location.id'],
      ...(options.shippingOptionId ? { filters: { id: options.shippingOptionId } } : {}),
    })
    let shippingOptionId = options.shippingOptionId
    if (shippingOptionId) {
      const option = shippingOptions.find(option => option.id === shippingOptionId)
      if (!option) {
        throw configurationError('plugin option shippingOptionId: no shipping option with this id')
      }
      if (profileId && option.shipping_profile_id !== profileId) {
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
    let byId: { id: string } | null = null
    const createOrder = async (normalised: string | null): Promise<CommandResult | undefined> => {
      const { data: regions } = await query.graph({ entity: 'region', fields: ['id', 'currency_code', 'countries.iso_2'] })
      const matchingRegions = regions.filter(region => region.currency_code.toLowerCase() === payload.currency.toLowerCase())
      const region = matchingRegions.find(region => region.countries?.some(
        country => country.iso_2.toLowerCase() === location.address.country_code.toLowerCase()
      )) ?? matchingRegions[0]
      const { data: variants } = await query.graph({
        entity: 'product_variant', fields: ['id', 'manage_inventory', 'allow_backorder',
          'product.status', 'product.deleted_at', 'product.sales_channels.id',
          'inventory_items.inventory_item_id', 'inventory_items.required_quantity'],
        filters: { id: payload.lines.map(line => line.variantId) },
      })
      const { address_1, address_2, city, country_code, province, postal_code, phone } = location.address
      const customer = normalised !== null ? pickCustomer(await container.resolve(Modules.CUSTOMER).listCustomers({
        email: { $ilike: escapeLike(normalised) },
      }, { take: null }), normalised) : byId
      const planned = planOrderCreate(payload, {
        customer,
        commandId: command.id, salesChannelId: channels[0].id,
        location: { id: location.id, address: { address_1, address_2, city, country_code, province, postal_code, phone } },
        region: region ? {
          id: region.id, currency_code: region.currency_code, country_codes: region.countries.map(country => country.iso_2),
        } : { id: '', currency_code: '', country_codes: [] },
        variants: Object.fromEntries(variants.filter(sellable).map(variant => [variant.id, { id: variant.id }])),
      })
      if (planned.ok === false) {
        if (planned.rejection.code === 'unsupported_currency') {
          throw new StoreConfigurationError(planned.rejection.message, 'unsupported_currency')
        }
        return { id: command.id, status: 'rejected', error: planned.rejection }
      }
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
    if (orderId) {
      await resumeOrderCreate(container, orderId, Number(minorToMajor(payload.totalMinor, currencyDecimals(payload.currency))),
        locationId, shippingOptionId)
    } else {
      const customerId = v3.customer?.customerId
      byId = customerId === undefined ? null : (await query.graph({
        entity: 'customer', fields: ['id'], filters: { id: customerId },
      })).data[0] ?? null
      const normalised = byId === null && typeof payload.customer?.email === 'string' && payload.customer.email !== ''
        ? normaliseCustomerEmail(payload.customer.email) : null
      // Lock order: tally_order advisory lock → tally_customer:<email> → stock locks.
      const rejected = normalised === null ? await createOrder(null)
        : await container.resolve(Modules.LOCKING).execute(`tally_customer:${normalised}`, () => createOrder(normalised))
      if (rejected) return rejected
    }
  }
  const { data: [order] } = await query.graph({
    entity: 'order', fields: ['id', 'display_id', 'total', 'raw_total', 'raw_tax_total', 'metadata', 'customer_id'], filters: { id: orderId },
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
  const serverTax = majorToMinor(order.raw_tax_total.value, currencyDecimals(payload.currency))
  const serverSubtotal = serverMinor - serverTax
  const tillCustomerId = typeof order.metadata?.tally_customer_id === 'string' ? order.metadata.tally_customer_id : undefined
  const warnings = [...totalWarnings(payload.totalMinor, serverMinor), ...(command.version >= 3 ? figuresWarnings(
    { subtotalMinor: payload.subtotalMinor, taxMinor: payload.taxMinor, discountMinor: payload.discountMinor ?? 0 },
    { subtotalMinor: serverSubtotal, taxMinor: serverTax }
  ) : []), ...customerWarnings(tillCustomerId, order.customer_id), ...stockWarnings]
  return {
    id: command.id, status: 'applied',
    serverRefs: { orderId: order.id, displayId: String(order.display_id), totalMinor: serverMinor },
    ...(warnings.length ? { warnings } : {}),
  }
}
