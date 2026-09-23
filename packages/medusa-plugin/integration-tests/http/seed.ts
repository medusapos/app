import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules, ProductStatus } from '@medusajs/framework/utils'
import {
  createInventoryLevelsWorkflow, createLocationFulfillmentSetWorkflow, createProductsWorkflow,
  createRegionsWorkflow, createServiceZonesWorkflow,
  createShippingOptionsWorkflow, createShippingProfilesWorkflow, createStockLocationsWorkflow,
  updateStoresWorkflow, createTaxRegionsWorkflow, linkSalesChannelsToStockLocationWorkflow,
} from '@medusajs/medusa/core-flows'

export async function seed(container: MedusaContainer) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const { data: [store] } = await query.graph({
    entity: 'store', fields: ['id', 'default_sales_channel_id'],
  })
  const channel = { id: store.default_sales_channel_id }
  await updateStoresWorkflow(container).run({ input: { selector: { id: store.id }, update: {
    name: 'POS test store',
    supported_currencies: [{ currency_code: 'eur', is_default: true }],
  } } })
  const { result: [region] } = await createRegionsWorkflow(container).run({ input: { regions: [{
    name: 'Europe', currency_code: 'eur', countries: ['de', 'dk'], automatic_taxes: true,
    payment_providers: ['pp_system_default'],
  }] } })
  await createTaxRegionsWorkflow(container).run({ input: [
    { country_code: 'de', provider_id: 'tp_system', default_tax_rate: { name: 'German VAT', rate: 19, code: 'DE19' } },
    { country_code: 'dk', provider_id: 'tp_system', default_tax_rate: { name: 'Danish VAT', rate: 25, code: 'DK25' } },
  ] })
  const { result: [profile] } = await createShippingProfilesWorkflow(container).run({
    input: { data: [{ name: 'POS shipping profile', type: 'default' }] },
  })
  const { result: locations } = await createStockLocationsWorkflow(container).run({ input: { locations: [
    { name: 'Berlin', address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
    { name: 'Spare', address: { address_1: 'Alexanderplatz 2', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
  ] } })
  const berlin = locations.find(location => location.name === 'Berlin')!
  const spare = locations.find(location => location.name === 'Spare')!
  await linkSalesChannelsToStockLocationWorkflow(container).run({ input: { id: berlin.id, add: [channel.id] } })
  const shippingOptionIds: string[] = []
  for (const location of locations) {
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: 'manual_manual' },
    })
    await createLocationFulfillmentSetWorkflow(container).run({ input: {
      location_id: location.id, fulfillment_set_data: { name: `${location.name} pickup`, type: 'pickup' },
    } })
    const { data: [stockLocation] } = await query.graph({
      entity: 'stock_location', fields: ['fulfillment_sets.id'], filters: { id: location.id },
    })
    const { result: [zone] } = await createServiceZonesWorkflow(container).run({ input: { data: [{
      name: `${location.name} Germany`, fulfillment_set_id: stockLocation.fulfillment_sets[0].id,
      geo_zones: [{ type: 'country', country_code: 'de' }],
    }] } })
    const { result: [option] } = await createShippingOptionsWorkflow(container).run({ input: [{
      name: 'In-store pickup', price_type: 'flat', provider_id: 'manual_manual',
      service_zone_id: zone.id, shipping_profile_id: profile.id,
      type: { label: 'Pickup', description: 'Collect in store', code: 'pickup' },
      prices: [{ currency_code: 'eur', amount: 0 }, { region_id: region.id, amount: 0 }],
    }] })
    shippingOptionIds.push(option.id)
  }
  const { result: [product] } = await createProductsWorkflow(container).run({ input: { products: [{
    title: 'POS test product', handle: 'pos-test-product', status: ProductStatus.PUBLISHED,
    shipping_profile_id: profile.id, sales_channels: [{ id: channel.id }],
    options: [{ title: 'Variant', values: ['A', 'B', 'C', 'D'] }],
    variants: [
      { title: 'A', sku: 'A', manage_inventory: true, options: { Variant: 'A' }, prices: [{ currency_code: 'eur', amount: 10 }] },
      { title: 'B', sku: 'B', manage_inventory: false, options: { Variant: 'B' }, prices: [{ currency_code: 'eur', amount: 5 }] },
      { title: 'C', sku: 'C', manage_inventory: true, options: { Variant: 'C' }, prices: [{ currency_code: 'eur', amount: 3 }] },
      { title: 'D', sku: 'D', manage_inventory: true, options: { Variant: 'D' }, prices: [{ currency_code: 'eur', amount: 3 }] },
    ],
  }] } })
  const { data: inventoryItems } = await query.graph({ entity: 'inventory_item', fields: ['id', 'sku'] })
  const inventoryA = inventoryItems.find(item => item.sku === 'A')!.id
  const inventoryC = inventoryItems.find(item => item.sku === 'C')!.id
  await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: [
    { inventory_item_id: inventoryA, location_id: berlin.id, stocked_quantity: 10 },
    { inventory_item_id: inventoryC, location_id: berlin.id, stocked_quantity: 1 },
  ] } })
  return {
    channelId: channel.id, regionId: region.id, berlinId: berlin.id, spareId: spare.id,
    berlinShippingOptionId: shippingOptionIds[locations.indexOf(berlin)],
    spareShippingOptionId: shippingOptionIds[locations.indexOf(spare)], inventoryA, inventoryC,
    inventoryD: inventoryItems.find(item => item.sku === 'D')!.id,
    variantA: product.variants.find(variant => variant.sku === 'A')!.id,
    variantB: product.variants.find(variant => variant.sku === 'B')!.id,
    variantC: product.variants.find(variant => variant.sku === 'C')!.id,
    variantD: product.variants.find(variant => variant.sku === 'D')!.id,
  }
}
