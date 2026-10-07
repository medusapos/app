import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateRegionsWorkflow, updateStoresWorkflow } from "@medusajs/medusa/core-flows"

// Matches the /demo page's wording.
export const DEMO_STORE_NAME = 'Medusa POS demo store'

// The grid's first lazy-loaded page on a phone, per the walkthrough.
export const FIRST_SCREEN_PRODUCTS = 48
// Keep this many units available for demo visitors after reservations.
export const FIRST_SCREEN_STOCK_FLOOR = 25

type StockProduct = {
  title: string
  variants?: ({ sku?: string | null; manage_inventory?: boolean; inventory_items?: ({ inventory_item_id?: string | null } | null)[] | null } | null)[] | null
}
type StockLevel = { inventory_item_id: string; stocked_quantity: number; reserved_quantity: number }

export function firstScreenTopUps(
  products: StockProduct[], levels: StockLevel[],
  count = FIRST_SCREEN_PRODUCTS, floor = FIRST_SCREEN_STOCK_FLOOR,
) {
  const existing = new Map(levels.map(level => [level.inventory_item_id, level]))
  const plan = new Map<string, { inventory_item_id: string; stocked_quantity: number; exists: boolean }>()
  const selected = products.filter(product => !product.variants?.some(variant => variant?.sku?.startsWith("E2E-")))
    .sort((a, b) => a.title.localeCompare(b.title)).slice(0, count)
  for (const product of selected) {
    for (const variant of product.variants ?? []) {
      if (!variant?.manage_inventory) continue
      for (const item of variant.inventory_items ?? []) {
        if (!item?.inventory_item_id) continue
        const level = existing.get(item.inventory_item_id)
        const reserved = level?.reserved_quantity ?? 0
        if ((level?.stocked_quantity ?? 0) - reserved >= floor) continue
        plan.set(item.inventory_item_id, {
          inventory_item_id: item.inventory_item_id, stocked_quantity: floor + reserved, exists: !!level,
        })
      }
    }
  }
  return [...plan.values()]
}

export default async function seedDemoPresentation({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const [store] = await container.resolve(Modules.STORE).listStores()
  if (!store) throw new Error("Missing store for demo presentation")
  const [region] = await container.resolve(Modules.REGION).listRegions({ name: "Europe" })
  if (!region) throw new Error("Missing Europe region for demo presentation")
  const pricing = container.resolve(Modules.PRICING)
  const [preference] = await pricing.listPricePreferences({ attribute: "currency_code", value: "eur" })
  if (!preference) throw new Error("Missing EUR currency price preference for demo presentation")

  await updateStoresWorkflow(container).run({ input: {
    selector: { id: store.id }, update: { name: DEMO_STORE_NAME },
  } })
  await updateRegionsWorkflow(container).run({ input: {
    selector: { id: region.id }, update: { is_tax_inclusive: true },
  } })
  await pricing.updatePricePreferences(preference.id, { is_tax_inclusive: true })
  logger.info(`Renamed store to "${DEMO_STORE_NAME}" and set Europe region and EUR currency prices to include VAT.`)

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: [channel] } = await query.graph({
    entity: "sales_channel", fields: ["id", "stock_locations.id"], filters: { id: store.default_sales_channel_id! },
  })
  const locationId = channel.stock_locations![0]!.id
  const { data: products } = await query.graph({
    entity: "product", filters: { status: "published" },
    fields: ["title", "variants.sku", "variants.manage_inventory", "variants.inventory_items.inventory_item_id"],
  })
  const inventory = container.resolve(Modules.INVENTORY)
  const levels = await inventory.listInventoryLevels({ location_id: locationId }, { take: null })
  const plan = firstScreenTopUps(products, levels)
  const updates = plan.filter(level => level.exists).map(({ exists, ...level }) => ({ ...level, location_id: locationId }))
  const creates = plan.filter(level => !level.exists).map(({ exists, ...level }) => ({ ...level, location_id: locationId }))
  if (updates.length) await inventory.updateInventoryLevels(updates)
  if (creates.length) await inventory.createInventoryLevels(creates)
  logger.info(`Raised ${plan.length} inventory levels for the demo's first screen of products.`)
}
