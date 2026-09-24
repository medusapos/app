import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import {
  createAndLinkProductOptionsToProductWorkflow, createInventoryLevelsWorkflow, createProductsWorkflow,
  createProductVariantsWorkflow, createRegionsWorkflow,
  createSalesChannelsWorkflow, createShippingOptionsWorkflow, createShippingProfilesWorkflow,
  createStockLocationsWorkflow, createStoresWorkflow, createTaxRegionsWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows"

export default async function seedE2e({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const fulfillment = container.resolve(Modules.FULFILLMENT)
  let [channel] = await container.resolve(Modules.SALES_CHANNEL).listSalesChannels({ name: "Default Sales Channel" })
  if (!channel) [channel] = (await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: "Default Sales Channel" }] },
  })).result
  const [store] = await container.resolve(Modules.STORE).listStores()
  if (!store) await createStoresWorkflow(container).run({ input: { stores: [{
    name: "E2E store", default_sales_channel_id: channel.id,
    supported_currencies: [{ currency_code: "eur", is_default: true }],
  }] } })
  let [region] = await container.resolve(Modules.REGION).listRegions({ name: "Europe" })
  if (!region) [region] = (await createRegionsWorkflow(container).run({ input: { regions: [{
    name: "Europe", currency_code: "eur", countries: ["dk", "de"], automatic_taxes: true,
    payment_providers: ["pp_system_default"],
  }] } })).result
  const taxRegions = await container.resolve(Modules.TAX).listTaxRegions({ country_code: ["dk", "de"] })
  const missingTaxRegions = [
    { country_code: "dk", provider_id: "tp_system", default_tax_rate: { name: "Danish VAT", rate: 25, code: "DK25" } },
    { country_code: "de", provider_id: "tp_system", default_tax_rate: { name: "German VAT", rate: 19, code: "DE19" } },
  ].filter(tax => !taxRegions.some(existing => existing.country_code === tax.country_code))
  if (missingTaxRegions.length) await createTaxRegionsWorkflow(container).run({ input: missingTaxRegions })
  let [location] = await container.resolve(Modules.STOCK_LOCATION).listStockLocations({ name: "Copenhagen" })
  if (!location) {
    const { data: [channelLinks] } = await query.graph({
      entity: "sales_channel", filters: { id: channel.id }, fields: ["stock_locations.id"],
    })
    const locationId = channelLinks.stock_locations?.[0]?.id
    if (locationId) [location] = await container.resolve(Modules.STOCK_LOCATION).listStockLocations({ id: locationId })
  }
  if (!location) [location] = (await createStockLocationsWorkflow(container).run({ input: { locations: [{
    name: "Copenhagen",
    address: { address_1: "Nørregade 1", city: "Copenhagen", country_code: "dk", postal_code: "1165" },
  }] } })).result
  const { data: [locationLinks] } = await query.graph({
    entity: "stock_location", filters: { id: location.id },
    fields: ["id", "sales_channels.id", "fulfillment_providers.id", "fulfillment_sets.id"],
  })
  if (!locationLinks.sales_channels?.some(existing => existing?.id === channel.id)) {
    await linkSalesChannelsToStockLocationWorkflow(container).run({ input: { id: location.id, add: [channel.id] } })
  }
  if (!locationLinks.fulfillment_providers?.some(existing => existing?.id === "manual_manual")) await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  })
  let [profile] = await fulfillment.listShippingProfiles({ name: "E2E shipping profile" })
  if (!profile) [profile] = (await createShippingProfilesWorkflow(container).run({
    input: { data: [{ name: "E2E shipping profile", type: "default" }] },
  })).result
  let [set] = await fulfillment.listFulfillmentSets({ name: "Copenhagen pickup" })
  if (!set) set = await fulfillment.createFulfillmentSets({
    name: "Copenhagen pickup", type: "pickup",
  })
  let [zone] = await fulfillment.listServiceZones({ fulfillment_set: { id: set.id }, name: "Denmark" })
  if (!zone) zone = await fulfillment.createServiceZones({
    fulfillment_set_id: set.id, name: "Denmark", geo_zones: [{ country_code: "dk", type: "country" }],
  })
  if (!locationLinks.fulfillment_sets?.some(existing => existing?.id === set.id)) await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: set.id },
  })
  const [shipping] = await fulfillment.listShippingOptions({ name: "In-store pickup" })
  if (!shipping) await createShippingOptionsWorkflow(container).run({ input: [{
    name: "In-store pickup", price_type: "flat", provider_id: "manual_manual",
    service_zone_id: zone.id, shipping_profile_id: profile.id,
    type: { label: "Pickup", description: "Collect in store", code: "pickup" },
    prices: [{ currency_code: "eur", amount: 0 }, { region_id: region.id, amount: 0 }],
  }] })
  const pricing = container.resolve(Modules.PRICING)
  const [preference] = await pricing.listPricePreferences({ attribute: "currency_code", value: "eur" })
  if (preference.is_tax_inclusive) await pricing.updatePricePreferences(preference.id, { is_tax_inclusive: false })
  const productService = container.resolve(Modules.PRODUCT)
  const products = await productService.listProducts(
    { handle: ["e2e-1", "e2e-2", "e2e-3", "e2e-4", "e2e-5"] },
    { relations: ["options", "options.values", "variants"] },
  )
  // E2E product 4 gets a second variant (SKU E2E-4B) so the variant chooser — the app's only
  // stock display, which opens only for a product with more than one variant — has a product
  // to exercise. Existing SKUs, barcodes, prices and stock are untouched.
  const missingProducts = [2, 3.5, 4.25, 10, 12.99].map((amount, i) => ({
    title: `E2E product ${i + 1}`, handle: `e2e-${i + 1}`, status: ProductStatus.PUBLISHED,
    shipping_profile_id: profile.id, sales_channels: [{ id: channel.id }],
    options: [{ title: "Variant", values: i === 3 ? ["Default", "B"] : ["Default"] }],
    variants: [
      {
        title: "Default", sku: `E2E-${i + 1}`, barcode: `20000000000${i + 1}${i + 1}`,
        manage_inventory: true, options: { Variant: "Default" },
        prices: [{ currency_code: "eur", amount }],
      },
      ...(i === 3 ? [{
        title: "B", sku: "E2E-4B", barcode: "2000000000046",
        manage_inventory: true, options: { Variant: "B" },
        prices: [{ currency_code: "eur", amount: 11 }],
      }] : []),
    ],
  })).filter(product => !products.some(existing => existing.handle === product.handle))
  if (missingProducts.length) await createProductsWorkflow(container).run({ input: { products: missingProducts } })

  // e2e-4 may already exist from a seed run before this fixture change, with only its Default
  // variant: add the B variant to it non-destructively (new products already got both above).
  const product4 = products.find(product => product.handle === "e2e-4")
  if (product4 && !product4.variants!.some(variant => variant.sku === "E2E-4B")) {
    const [variantOption] = product4.options!
    await createAndLinkProductOptionsToProductWorkflow(container).run({ input: {
      product_id: product4.id,
      update: [{ product_option_id: variantOption.id, add: [{ value: "B" }] }],
    } })
    await createProductVariantsWorkflow(container).run({ input: { product_variants: [{
      product_id: product4.id, title: "B", sku: "E2E-4B", barcode: "2000000000046",
      manage_inventory: true, options: { Variant: "B" },
      prices: [{ currency_code: "eur", amount: 11 }],
    }] } })
  }

  const inventoryService = container.resolve(Modules.INVENTORY)
  const inventory = await inventoryService.listInventoryItems({ sku: ["E2E-1", "E2E-2", "E2E-3", "E2E-4", "E2E-4B", "E2E-5"] })
  const levels = await inventoryService.listInventoryLevels({ location_id: location.id })
  const missingLevels = inventory.filter(item => !levels.some(level => level.inventory_item_id === item.id))
  if (missingLevels.length) await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: missingLevels.map(item => ({
    inventory_item_id: item.id, location_id: location.id, stocked_quantity: item.sku === "E2E-5" ? 2 : 50,
  })) } })
  container.resolve(ContainerRegistrationKeys.LOGGER).info("e2e seed ok")
}
