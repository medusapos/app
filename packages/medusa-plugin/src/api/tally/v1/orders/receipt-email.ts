import type { CreateNotificationDTO } from '@medusajs/framework/types'
import { validateEmail } from '@medusajs/framework/utils'
import { currencyDecimals, majorToMinor } from '../../../../workflows/tally-order-create/money'

// The store's email provider maps this id to its own template.
export const RECEIPT_EMAIL_TEMPLATE = 'tally-pos-receipt'
export const RECEIPT_EMAIL_TRIGGER = 'tally.receipt_email'
// The longest address SMTP allows (RFC 5321 path limit).
export const MAX_EMAIL_LENGTH = 254

export type ReceiptEmailRequest = { email: string; saveToBilling: boolean }

export function parseReceiptEmailBody(body: unknown): { ok: true; value: ReceiptEmailRequest } | { ok: false; message: string } {
  const plain = typeof body === 'object' && body !== null &&
    (Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null)
  const payload = (plain ? body : {}) as Record<string, unknown>
  const errors: string[] = []
  let validEmail = typeof payload.email === 'string' && payload.email.length > 0 && payload.email.length <= MAX_EMAIL_LENGTH
  if (validEmail) {
    try { validateEmail(payload.email as string) } catch { validEmail = false }
  }
  if (!validEmail) errors.push('email: expected an email address of at most 254 characters')
  if ('saveToBilling' in payload && typeof payload.saveToBilling !== 'boolean') errors.push('saveToBilling: expected a boolean')
  if (errors.length) return { ok: false, message: errors.join('; ') }
  return { ok: true, value: { email: payload.email as string, saveToBilling: (payload.saveToBilling ?? false) as boolean } }
}

type Raw = { value: string | number }
export type ReceiptOrder = {
  id: string; display_id: number; currency_code: string; created_at: string | Date; is_draft_order?: boolean | null
  metadata?: Record<string, unknown> | null
  raw_total: Raw; raw_subtotal: Raw; raw_tax_total: Raw; raw_discount_total: Raw; raw_shipping_total: Raw
  items?: Array<{ id: string; title: string; variant_title?: string | null; variant_sku?: string | null
    raw_quantity: Raw; raw_unit_price: Raw; raw_total: Raw } | null> | null
}

export function isTillOrder(order: { is_draft_order?: boolean | null; metadata?: Record<string, unknown> | null }): boolean {
  return typeof order.metadata?.tally_client_id === 'string' && order.is_draft_order !== true
}

export type ReceiptEmailData = {
  order: { id: string; displayId: string; clientOrderId: string; createdAt: string; currencyCode: string; exponent: number
    items: Array<{ title: string; variantTitle: string | null; sku: string | null; quantity: number; unitPriceMinor: number; totalMinor: number }>
    subtotalMinor: number; taxTotalMinor: number; discountTotalMinor: number; shippingTotalMinor: number; totalMinor: number }
  posTotals: Record<string, unknown> | null
}

export function buildReceiptNotification(order: ReceiptOrder, to: string): CreateNotificationDTO & { data: ReceiptEmailData } {
  const exponent = currencyDecimals(order.currency_code)
  const metadata = order.metadata ?? {}
  const totals = metadata.tally_pos_totals
  return {
    to, channel: 'email', template: RECEIPT_EMAIL_TEMPLATE, trigger_type: RECEIPT_EMAIL_TRIGGER,
    resource_id: order.id, resource_type: 'order',
    data: {
      order: {
        id: order.id, displayId: String(order.display_id), clientOrderId: metadata.tally_client_id as string,
        createdAt: typeof metadata.tally_created_at === 'string' ? metadata.tally_created_at : new Date(order.created_at).toISOString(),
        currencyCode: order.currency_code, exponent,
        // Money fields are minor units, the same as tally_pos_totals, so the template formats both one way.
        items: (order.items ?? []).filter((item): item is NonNullable<typeof item> => item !== null).map(item => ({
          title: item.title, variantTitle: item.variant_title ?? null, sku: item.variant_sku ?? null,
          quantity: Number(item.raw_quantity.value), unitPriceMinor: majorToMinor(item.raw_unit_price.value, exponent),
          totalMinor: majorToMinor(item.raw_total.value, exponent),
        })),
        subtotalMinor: majorToMinor(order.raw_subtotal.value, exponent), taxTotalMinor: majorToMinor(order.raw_tax_total.value, exponent),
        discountTotalMinor: majorToMinor(order.raw_discount_total.value, exponent),
        shippingTotalMinor: majorToMinor(order.raw_shipping_total.value, exponent), totalMinor: majorToMinor(order.raw_total.value, exponent),
      },
      posTotals: typeof totals === 'object' && totals !== null && !Array.isArray(totals)
        ? structuredClone(totals) as Record<string, unknown> : null,
    },
  }
}
