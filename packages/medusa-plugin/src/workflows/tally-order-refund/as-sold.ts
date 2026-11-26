import { getLineItemTotals } from '@medusajs/framework/utils'
import { connectorSplit } from './price'

type Raw = { value: string }
export type SoldItem = { id: string; quantity: number; raw_total: Raw; raw_tax_total: Raw; raw_unit_price?: Raw | null; is_tax_inclusive?: boolean
  tax_lines?: ({ rate: number } | null)[] | null; adjustments?: ({ raw_amount: Raw; is_tax_inclusive?: boolean } | null)[] | null }
// #583: Medusa shrinks item totals as returns are received; refunds price from the totals as sold (the graph's adjustments are the current version's).
export function asSoldSplit(item: SoldItem, decimals: number): { netMinor: number; taxMinor: number } {
  const live = () => connectorSplit(item.raw_total.value, item.raw_tax_total.value, decimals)
  // Fallback: an item without a unit price, or one Medusa's totals refuse, keeps today's live split.
  if (item.raw_unit_price?.value == null) return live()
  try {
    const sold = getLineItemTotals({ id: item.id, unit_price: item.raw_unit_price, quantity: item.quantity, is_tax_inclusive: item.is_tax_inclusive,
      tax_lines: (item.tax_lines ?? []).flatMap(line => line ? [{ rate: line.rate }] : []), adjustments: (item.adjustments ?? []).flatMap(adj => adj ? [{ amount: adj.raw_amount, is_tax_inclusive: adj.is_tax_inclusive }] : []),
    } as unknown as Parameters<typeof getLineItemTotals>[0], { includeTax: item.is_tax_inclusive })
    return connectorSplit(sold.total.raw!.value, sold.tax_total.raw!.value, decimals)
  } catch { return live() }
}

export function returnedQuantity(item: { detail?: { return_requested_quantity?: unknown; return_received_quantity?: unknown; return_dismissed_quantity?: unknown } | null }): number {
  // A dismiss also adds to written_off_quantity (Medusa's receive-damaged action), so that field is not added again.
  return Number(item.detail?.return_requested_quantity ?? 0) + Number(item.detail?.return_received_quantity ?? 0) + Number(item.detail?.return_dismissed_quantity ?? 0)
}
