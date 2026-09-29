import type { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function g4DirectWrites({ container }: ExecArgs) {
  const { priceId, levelId, inventoryItemId, locationId, variantId } = JSON.parse(process.env.G4_DIRECT_IDS!)
  const pricing = container.resolve(Modules.PRICING)
  const inventory = container.resolve(Modules.INVENTORY)
  const product = container.resolve(Modules.PRODUCT)

  await pricing.updatePrices({ id: priceId, amount: 42 })
  console.log(`Updated price ${priceId}`)
  await inventory.updateInventoryLevels({
    id: levelId, inventory_item_id: inventoryItemId, location_id: locationId, stocked_quantity: 42,
  })
  console.log(`Updated inventory level ${levelId}`)
  await product.updateProductVariants(variantId, { title: "M direct" })
  console.log(`Updated variant ${variantId}`)
}
