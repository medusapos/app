import type { OrderCreatePayload, CommandWarning } from '@tallyui/core'
import { currencyDecimals, minorToMajor } from './money'

export type OrderRejectionCode =
  'unknown_variant' | 'invalid_quantity' | 'underpaid' | 'unsupported_currency'

export type Rejection = { code: OrderRejectionCode; message: string }

export type LocationAddress = {
  address_1?: string | null; address_2?: string | null; city?: string | null
  country_code: string; province?: string | null; postal_code?: string | null; phone?: string | null
}

/** Medusa data already fetched by the caller. */
export type PlanContext = {
  commandId: string
  region: { id: string; currency_code: string; country_codes: string[] }
  salesChannelId: string
  location: { id: string; address: LocationAddress }
  variants: Record<string, { id: string }>
}

export type DraftOrderItemInput = {
  variant_id: string; quantity: number; unit_price: string; is_tax_inclusive: boolean
  metadata: { tally_line_uuid: string }
  /** Only on a discounted line (ADR-062): one adjustment of its discountMinor, in its own tax mode. No code:
   * createOrderWorkflow's promotion refresh deletes every adjustment whose code is not an applied promotion. */
  adjustments?: Array<{ amount: string; description: 'POS discount'; is_tax_inclusive: boolean }>
}

export type OrderCreatePlan = {
  currencyCode: string
  decimals: number
  locationId: string
  /** Exactly totalMinor in major units, even when the POS accepted overpayment. */
  paymentAmount: string
  draftOrder: {
    status: 'draft'; is_draft_order: true
    region_id: string; sales_channel_id: string; currency_code: string
    email?: string
    shipping_address: LocationAddress; billing_address: LocationAddress
    no_notification: true
    metadata: Record<string, unknown>
    items: DraftOrderItemInput[]
  }
}

export function planOrderCreate(payload: OrderCreatePayload, ctx: PlanContext):
  { ok: true; plan: OrderCreatePlan } | { ok: false; rejection: Rejection } {
  if (payload.lines.length === 0) {
    return { ok: false, rejection: { code: 'invalid_quantity', message: 'Invalid lines: must not be empty' } }
  }
  const fields: Array<[string, number, number]> = []
  payload.lines.forEach((line, i) => {
    fields.push([`lines[${i}].quantity`, line.quantity, 1], [`lines[${i}].unitPriceMinor`, line.unitPriceMinor, 0])
    if (line.discountMinor !== undefined) fields.push([`lines[${i}].discountMinor`, line.discountMinor, 1])
  })
  for (const field of ['subtotalMinor', 'taxMinor', 'totalMinor'] as const) {
    fields.push([field, payload[field], 0])
  }
  payload.payments.forEach((payment, i) => {
    fields.push([`payments[${i}].amountMinor`, payment.amountMinor, 0])
    for (const field of ['tenderedMinor', 'changeMinor'] as const) {
      if (payment[field] !== undefined) fields.push([`payments[${i}].${field}`, payment[field], 0])
    }
  })
  for (const [field, value, minimum] of fields) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      return { ok: false, rejection: { code: 'invalid_quantity', message: `Invalid ${field}` } }
    }
  }
  const over = payload.lines.findIndex(line => BigInt(line.discountMinor ?? 0) > BigInt(line.unitPriceMinor) * BigInt(line.quantity))
  if (over >= 0) return { ok: false, rejection: { code: 'invalid_quantity', message: `Invalid lines[${over}].discountMinor: exceeds the line amount` } }

  const currencyCode = payload.currency.toLowerCase()
  if (currencyCode !== ctx.region.currency_code.toLowerCase()) {
    return { ok: false, rejection: { code: 'unsupported_currency', message: `Currency ${payload.currency} differs from region currency` } }
  }
  let decimals: number
  try {
    decimals = currencyDecimals(currencyCode)
  } catch {
    return { ok: false, rejection: { code: 'unsupported_currency', message: `Unsupported currency ${payload.currency}` } }
  }
  const address = { ...ctx.location.address, country_code: ctx.location.address.country_code.toLowerCase() }
  if (!ctx.region.country_codes.some(country => country.toLowerCase() === address.country_code)) {
    return { ok: false, rejection: { code: 'unsupported_currency', message: `Location country ${address.country_code} is outside region` } }
  }

  const unknownIds = payload.lines.map(line => line.variantId)
    .filter(id => !Object.prototype.hasOwnProperty.call(ctx.variants, id))
  if (unknownIds.length > 0) {
    return { ok: false, rejection: { code: 'unknown_variant', message: `Unknown variants: ${unknownIds.join(', ')}` } }
  }
  const paid = payload.payments.reduce((sum, payment) => sum + BigInt(payment.amountMinor), 0n)
  if (paid < BigInt(payload.totalMinor)) {
    return { ok: false, rejection: { code: 'underpaid', message: 'Payment amounts are less than totalMinor' } }
  }

  return {
    ok: true,
    plan: {
      currencyCode,
      decimals,
      locationId: ctx.location.id,
      paymentAmount: minorToMajor(payload.totalMinor, decimals),
      draftOrder: {
        status: 'draft',
        is_draft_order: true,
        region_id: ctx.region.id,
        sales_channel_id: ctx.salesChannelId,
        currency_code: currencyCode,
        ...(typeof payload.customer?.email === 'string' && payload.customer.email.length > 0
          ? { email: payload.customer.email } : {}),
        shipping_address: { ...address },
        billing_address: { ...address },
        no_notification: true,
        metadata: {
          tally_client_id: payload.clientOrderId,
          tally_created_at: payload.createdAt,
          tally_command_id: ctx.commandId,
          tally_payments: payload.payments,
          ...(payload.registerId !== undefined ? { tally_register_id: payload.registerId } : {}),
          ...(payload.cashierRef !== undefined ? { tally_cashier_ref: payload.cashierRef } : {}),
        },
        items: payload.lines.map(line => ({
          variant_id: line.variantId,
          quantity: line.quantity,
          unit_price: minorToMajor(line.unitPriceMinor, decimals),
          // A line's own tax mode wins; absent means the order's (ADR-038 amendment).
          is_tax_inclusive: line.taxInclusive ?? payload.pricesIncludeTax,
          metadata: { tally_line_uuid: line.clientLineId },
          // The whole line's discount in the item's mode: gross when inclusive, net otherwise (ADR-062).
          ...(line.discountMinor !== undefined ? { adjustments: [{ amount: minorToMajor(line.discountMinor, decimals),
            description: 'POS discount' as const, is_tax_inclusive: line.taxInclusive ?? payload.pricesIncludeTax }] } : {}),
        })),
      },
    },
  }
}

/** Shipping group first, empty groups omitted, input order retained within each group. */
export function fulfillmentGroups<T extends { id: string; quantity: number; requires_shipping: boolean }>(
  items: T[]
): Array<Array<{ id: string; quantity: number }>> {
  return [true, false].map(requiresShipping => items
    .filter(item => item.requires_shipping === requiresShipping)
    .map(({ id, quantity }) => ({ id, quantity })))
    .filter(group => group.length > 0)
}

export function totalWarnings(expectedMinor: number, serverMinor: number): CommandWarning[] {
  return serverMinor === expectedMinor ? [] : [{ code: 'total_mismatch', expectedMinor, serverMinor }]
}
