export type StockTopUp = { inventory_item_id: string; location_id: string; shortfall: number }

export function mergeStockTopUps(...lists: StockTopUp[][]): StockTopUp[] {
  const merged: StockTopUp[] = []
  for (const topUp of lists.flat()) {
    const existing = merged.find(item => item.inventory_item_id === topUp.inventory_item_id && item.location_id === topUp.location_id)
    if (existing) existing.shortfall += topUp.shortfall
    else merged.push({ ...topUp })
  }
  return merged
}

export type VariantInventory = { variantId: string; manageInventory: boolean
  items: Array<{ inventoryItemId: string; requiredQuantity: number }> }
export type LevelAt = { inventoryItemId: string; stocked: number; reserved: number }

export function planStockTopUp(lines: Array<{ variantId: string; quantity: number }>,
  variants: VariantInventory[], levels: LevelAt[]): {
  topUps: Array<{ inventoryItemId: string; shortfall: number }>
  missingLevels: string[]
  warnings: Array<{ code: 'insufficient_stock'; variantId: string; quantity: number }>
} {
  const managed = variants.filter(variant => variant.manageInventory && lines.some(line => line.variantId === variant.variantId))
  const needed = new Map<string, number>()
  for (const variant of managed) {
    const quantity = lines.filter(line => line.variantId === variant.variantId).reduce((sum, line) => sum + line.quantity, 0)
    for (const item of variant.items) {
      needed.set(item.inventoryItemId, (needed.get(item.inventoryItemId) ?? 0) + quantity * item.requiredQuantity)
    }
  }
  const missingLevels: string[] = []
  const topUps: Array<{ inventoryItemId: string; shortfall: number }> = []
  for (const [inventoryItemId, quantity] of needed) {
    const level = levels.find(level => level.inventoryItemId === inventoryItemId)
    if (!level) missingLevels.push(inventoryItemId)
    const shortfall = quantity - (level ? level.stocked - level.reserved : 0)
    if (shortfall > 0) topUps.push({ inventoryItemId, shortfall })
  }
  const warnings = managed.flatMap(variant => {
    const quantity = Math.max(0, ...variant.items.map(item => Math.ceil(
      (topUps.find(topUp => topUp.inventoryItemId === item.inventoryItemId)?.shortfall ?? 0) / item.requiredQuantity
    )))
    return quantity > 0 ? [{ code: 'insufficient_stock' as const, variantId: variant.variantId, quantity }] : []
  })
  return { topUps, missingLevels, warnings }
}
