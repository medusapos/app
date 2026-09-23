import { planStockTopUp, type VariantInventory } from '../stock'

const variant: VariantInventory = { variantId: 'v', manageInventory: true,
  items: [{ inventoryItemId: 'i', requiredQuantity: 1 }] }
const line = { variantId: 'v', quantity: 2 }
const level = { inventoryItemId: 'i', stocked: 2, reserved: 0 }
const warning = (quantity: number) => ({ code: 'insufficient_stock', variantId: 'v', quantity })

describe('planStockTopUp', () => {
  it('does nothing with enough stock', () => {
    expect(planStockTopUp([line], [variant], [level])).toEqual({ topUps: [], missingLevels: [], warnings: [] })
  })
  it('tops up and warns for a shortfall of one', () => {
    expect(planStockTopUp([line], [variant], [{ ...level, stocked: 1 }])).toEqual({
      topUps: [{ inventoryItemId: 'i', shortfall: 1 }], missingLevels: [], warnings: [warning(1)],
    })
  })
  it('subtracts reserved stock from availability', () => {
    expect(planStockTopUp([line], [variant], [{ ...level, reserved: 1 }])).toEqual({
      topUps: [{ inventoryItemId: 'i', shortfall: 1 }], missingLevels: [], warnings: [warning(1)],
    })
  })
  it('ignores unmanaged variants', () => {
    expect(planStockTopUp([line], [{ ...variant, manageInventory: false }], [])).toEqual({
      topUps: [], missingLevels: [], warnings: [],
    })
  })
  it('lists missing levels and tops up the full need', () => {
    expect(planStockTopUp([line], [variant], [])).toEqual({
      topUps: [{ inventoryItemId: 'i', shortfall: 2 }], missingLevels: ['i'], warnings: [warning(2)],
    })
  })
  it('adds two lines of the same variant', () => {
    expect(planStockTopUp([line, line], [variant], [level])).toEqual({
      topUps: [{ inventoryItemId: 'i', shortfall: 2 }], missingLevels: [], warnings: [warning(2)],
    })
  })
  it('rounds item shortfall up to variant units', () => {
    expect(planStockTopUp([line], [{ ...variant, items: [{ inventoryItemId: 'i', requiredQuantity: 2 }] }],
      [{ ...level, stocked: 1 }])).toEqual({
      topUps: [{ inventoryItemId: 'i', shortfall: 3 }], missingLevels: [], warnings: [warning(2)],
    })
  })
  it('takes the largest shortfall over several items', () => {
    expect(planStockTopUp([line], [{ ...variant, items: [...variant.items, { inventoryItemId: 'j', requiredQuantity: 2 }] }],
      [{ ...level, stocked: 1 }, { inventoryItemId: 'j', stocked: 1, reserved: 0 }])).toEqual({
      topUps: [{ inventoryItemId: 'i', shortfall: 1 }, { inventoryItemId: 'j', shortfall: 3 }],
      missingLevels: [], warnings: [warning(2)],
    })
  })
})
