import type { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function g4DirectWrites({ container }: ExecArgs) {
  const { priceId, levelId, inventoryItemId, locationId, variantId } = JSON.parse(process.env.G4_DIRECT_IDS!)
  const { amount, stocked, title } = JSON.parse(process.env.G4_DIRECT_VALUES ??
    JSON.stringify({ amount: 42, stocked: 42, title: "M direct" }))
  const pricing = container.resolve(Modules.PRICING)
  const inventory = container.resolve(Modules.INVENTORY)
  const product = container.resolve(Modules.PRODUCT)

  // MedusaService generates the method, but IPricingModuleService doesn't declare it.
  await (pricing as unknown as { updatePrices(data: { id: string; amount: number }): Promise<unknown> }).updatePrices({ id: priceId, amount })
  console.log(`Updated price ${priceId}`)
  await inventory.updateInventoryLevels({
    id: levelId, inventory_item_id: inventoryItemId, location_id: locationId, stocked_quantity: stocked,
  })
  console.log(`Updated inventory level ${levelId}`)
  await product.updateProductVariants(variantId, { title })
  console.log(`Updated variant ${variantId}`)
}
