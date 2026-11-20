import type {
  ListOrdersQuery, OrderFilterField, PaymentMethodKind, StoreOrder, StoreOrderCharge, StoreOrderLine, StoreOrderPage, StoreOrderPayment,
} from '@tallyui/core' with { 'resolution-mode': 'import' }
import { MathBN } from '@medusajs/framework/utils'
import { currencyDecimals, majorToMinor } from '../../../../workflows/tally-order-create/money'

export const ORDERS_DEFAULT_PER_PAGE = 25
// Core's ListOrdersQuery caps perPage at 100; it also bounds one query.graph read of whole orders with their relations.
export const ORDERS_MAX_PER_PAGE = 100
// display_id is a Postgres integer: a longer run of digits matches no order rather than failing the query.
const MAX_DISPLAY_ID = 2147483647

export type OrdersQuery = ListOrdersQuery & { page: number; perPage: number; allChannels: boolean }
export type OrdersQueryError =
  | { code: 'unsupported_order_filter'; fields: OrderFilterField[] }
  | { code: 'invalid_query'; message: string }

const PARAMS = ['page', 'perPage', 'search', 'status', 'customerId', 'registerId', 'after', 'before', 'allChannels']
// Core's ORDER_FILTER_FIELDS order (the plugin imports core as types only); this route has no cashier, payment-method,
// store or created-via filter.
const UNSUPPORTED: readonly OrderFilterField[] = ['cashierId', 'paymentMethod', 'storeId', 'createdVia']
// Core's assertOrderDateRange rule, kept here because the plugin imports core as types only.
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/

function wholeNumber(value: unknown): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

export function parseOrdersQuery(raw: Record<string, unknown>): { ok: true; query: OrdersQuery } | { ok: false; error: OrdersQueryError } {
  const fields = UNSUPPORTED.filter(field => raw[field] !== undefined)
  if (fields.length) return { ok: false, error: { code: 'unsupported_order_filter', fields } }
  const invalid = (message: string) => ({ ok: false as const, error: { code: 'invalid_query' as const, message } })
  const unknown = Object.keys(raw).filter(key => !PARAMS.includes(key))
  if (unknown.length) return invalid(`unknown parameters: ${unknown.join(', ')}`)
  // A repeated or bracketed parameter arrives as an array or object, never as a filter.
  const notString = PARAMS.filter(key => raw[key] !== undefined && typeof raw[key] !== 'string')
  if (notString.length) return invalid(`expected one string value for: ${notString.join(', ')}`)
  if (raw.allChannels !== undefined && raw.allChannels !== 'true' && raw.allChannels !== 'false') {
    return invalid('allChannels must be true or false')
  }
  const query: OrdersQuery = { page: 1, perPage: ORDERS_DEFAULT_PER_PAGE, allChannels: raw.allChannels === 'true' }
  if (raw.page !== undefined) {
    const page = wholeNumber(raw.page)
    if (page === undefined || page < 1) return invalid('page must be an integer >= 1')
    query.page = page
  }
  if (raw.perPage !== undefined) {
    const perPage = wholeNumber(raw.perPage)
    if (perPage === undefined) return invalid('perPage must be an integer')
    query.perPage = Math.min(ORDERS_MAX_PER_PAGE, Math.max(1, perPage))
  }
  if (!Number.isSafeInteger((query.page - 1) * query.perPage)) return invalid('page is too large')
  for (const key of ['search', 'status', 'customerId', 'registerId'] as const) {
    if (raw[key] !== undefined) query[key] = raw[key] as string
  }
  const ends: Array<['after' | 'before', number]> = []
  for (const end of ['after', 'before'] as const) {
    const value = raw[end] as string | undefined
    if (value === undefined) continue
    const ms = UTC_INSTANT.test(value) ? Date.parse(value) : Number.NaN
    if (Number.isNaN(ms)) return invalid(`${end} must be an ISO 8601 UTC instant ending in Z`)
    query.dateRange = { ...query.dateRange, [end]: value }
    ends.push([end, ms])
  }
  if (ends.length === 2 && ends[0][1] > ends[1][1]) return invalid('after is later than before')
  return { ok: true, query }
}

/** The query.graph filters for the till's sales channel, or null when the query can match no order. */
export function orderFilters(query: OrdersQuery, scope: { salesChannelId: string } | 'all'): Record<string, unknown> | null {
  // An empty filter value is set, and no order has an empty status, customer or register.
  if (query.status === '' || query.customerId === '' || query.registerId === '') return null
  const filters: Record<string, unknown> = { is_draft_order: false }
  if (scope !== 'all') filters.sales_channel_id = scope.salesChannelId
  if (query.status !== undefined) filters.status = query.status
  if (query.customerId !== undefined) filters.customer_id = query.customerId
  if (query.registerId !== undefined) filters.metadata = { tally_register_id: query.registerId }
  const { after, before } = query.dateRange ?? {}
  if (after !== undefined || before !== undefined) {
    filters.created_at = { ...(after !== undefined ? { $gte: after } : {}), ...(before !== undefined ? { $lt: before } : {}) }
  }
  const search = query.search?.trim()
  if (search && /^\d+$/.test(search)) {
    if (Number(search) > MAX_DISPLAY_ID) return null
    filters.display_id = Number(search)
  } else if (search) {
    filters.q = search
  }
  return filters
}

/** Every field toStoreOrder reads, for one query.graph call. Selecting `total` makes the order module compute totals. */
export const ORDER_FIELDS = [
  'id', 'display_id', 'status', 'created_at', 'currency_code', 'email', 'customer_id', 'metadata',
  'raw_total', 'raw_tax_total', 'raw_discount_total', 'raw_discount_tax_total', 'total',
  'customer.id', 'customer.first_name', 'customer.last_name', 'customer.email',
  'items.id', 'items.title', 'items.product_id', 'items.variant_id', 'items.variant_sku', 'items.raw_quantity',
  'items.is_tax_inclusive', 'items.metadata', 'items.raw_total', 'items.raw_tax_total', 'items.raw_original_total',
  'items.raw_original_tax_total', 'items.tax_lines.rate', 'items.tax_lines.code', 'items.tax_lines.description',
  'items.adjustments.code', 'items.adjustments.raw_amount', 'items.adjustments.is_tax_inclusive',
  'shipping_methods.name', 'shipping_methods.raw_total', 'shipping_methods.raw_tax_total', 'shipping_methods.tax_lines.rate',
  'shipping_methods.tax_lines.code', 'shipping_methods.tax_lines.description', 'shipping_methods.adjustments.code',
  'shipping_methods.adjustments.raw_amount', 'shipping_methods.adjustments.is_tax_inclusive',
  'payment_collections.payments.id', 'payment_collections.payments.provider_id', 'payment_collections.payments.raw_amount',
  'payment_collections.payments.canceled_at', 'payment_collections.payments.refunds.id',
  'payment_collections.payments.refunds.raw_amount', 'payment_collections.payments.refunds.note',
  'payment_collections.payments.refunds.refund_reason.label',
]

type Raw = { value: string | number }
type TaxLineRow = { rate: string | number; code?: string | null; description?: string | null }
type AdjustmentRow = { code?: string | null; raw_amount: Raw; is_tax_inclusive?: boolean | null }
type ChargeRow = { raw_total: Raw; raw_tax_total: Raw; tax_lines?: Array<TaxLineRow | null> | null; adjustments?: Array<AdjustmentRow | null> | null }
type ItemRow = ChargeRow & {
  id: string; title: string; product_id?: string | null; variant_id?: string | null; variant_sku?: string | null; raw_quantity: Raw
  is_tax_inclusive?: boolean | null; metadata?: Record<string, unknown> | null; raw_original_total: Raw; raw_original_tax_total: Raw
}
type PaymentRow = {
  id: string; provider_id: string; raw_amount: Raw; canceled_at?: string | Date | null
  refunds?: Array<{ id: string; raw_amount: Raw; note?: string | null; refund_reason?: { label?: string | null } | null } | null> | null
}
export type OrderRow = {
  id: string; display_id: number; status: string; created_at: string | Date; currency_code: string
  email?: string | null; customer_id?: string | null; metadata?: Record<string, unknown> | null
  raw_total: Raw; raw_tax_total: Raw; raw_discount_total: Raw; raw_discount_tax_total: Raw
  customer?: { id?: string | null; first_name?: string | null; last_name?: string | null; email?: string | null } | null
  items?: Array<ItemRow | null> | null
  shipping_methods?: Array<(ChargeRow & { name: string }) | null> | null
  payment_collections?: Array<{ payments?: Array<PaymentRow | null> | null } | null> | null
}

const present = <T>(rows: Array<T | null> | null | undefined): T[] => (rows ?? []).filter((row): row is T => row != null)
const nonEmpty = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined)
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const TILL_KINDS: readonly PaymentMethodKind[] = ['cash', 'external']
const sumRate = (row: ChargeRow) => MathBN.sum(0, ...present(row.tax_lines).map(line => line.rate))

/** The tax such that net + tax is the gross rounded once: gross and tax are each rounded once, net is their difference. */
function split(gross: Raw | string, tax: Raw | string, decimals: number) {
  const grossMinor = majorToMinor(typeof gross === 'string' ? gross : gross.value, decimals)
  const taxMinor = majorToMinor(typeof tax === 'string' ? tax : tax.value, decimals)
  return { netMinor: grossMinor - taxMinor, taxMinor }
}

function charge(name: string, row: ChargeRow, decimals: number): StoreOrderCharge {
  const { netMinor, taxMinor } = split(row.raw_total, row.raw_tax_total, decimals)
  return { name, totalMinor: netMinor, taxMinor }
}

/** The till's payment kind when every payment the till recorded is of one kind. */
function tillKind(metadata: Record<string, unknown>): PaymentMethodKind | undefined {
  const payments = metadata.tally_payments
  if (!Array.isArray(payments) || payments.length === 0) return undefined
  const kinds = new Set(payments.map(payment => (payment as { method?: unknown } | null)?.method))
  const [kind] = kinds
  return kinds.size === 1 && TILL_KINDS.includes(kind as PaymentMethodKind) ? kind as PaymentMethodKind : undefined
}

export function toStoreOrder(row: OrderRow): StoreOrder {
  const decimals = currencyDecimals(row.currency_code)
  const metadata = row.metadata ?? {}
  const items = present(row.items)
  const shippingMethods = present(row.shipping_methods)
  const isFee = (item: ItemRow) => item.metadata?.tally_fee_uuid !== undefined

  const customerId = nonEmpty(row.customer_id) ?? nonEmpty(row.customer?.id)
  const name = [row.customer?.first_name, row.customer?.last_name].filter(part => nonEmpty(part)).join(' ').trim()
  const email = nonEmpty(row.email) ?? nonEmpty(row.customer?.email)
  const tillCreatedAt = typeof metadata.tally_created_at === 'string' && ISO_INSTANT.test(metadata.tally_created_at)
    && !Number.isNaN(Date.parse(metadata.tally_created_at)) ? metadata.tally_created_at : undefined

  const taxes = new Map<string, { label: string; code?: string; ratePpm: number; amount: ReturnType<typeof MathBN.convert> }>()
  const coupons = new Map<string, { gross: ReturnType<typeof MathBN.convert>; tax: ReturnType<typeof MathBN.convert> }>()
  for (const charged of [...items, ...shippingMethods]) {
    const rates = sumRate(charged)
    // An item with several tax lines splits its tax by rate, as Medusa computes each line's tax on the same net amount.
    for (const line of present(charged.tax_lines)) {
      const code = nonEmpty(line.code)
      const key = `${code ?? ''}\u0000${line.rate}`
      const share = MathBN.eq(rates, 0) ? MathBN.convert(0) : MathBN.div(MathBN.mult(charged.raw_tax_total.value, line.rate), rates)
      const entry = taxes.get(key) ?? { label: line.description ?? code ?? '', ...(code ? { code } : {}),
        ratePpm: Math.round(Number(line.rate) * 10000), amount: MathBN.convert(0) }
      taxes.set(key, { ...entry, amount: MathBN.add(entry.amount, share) })
    }
    // Medusa's own split (calculateAdjustmentTotal): a tax-inclusive adjustment's amount is gross, and its tax is the part
    // above amount / (1 + rate); a tax-exclusive adjustment's amount is net, and its tax is amount × rate. The code's gross
    // and its tax are each summed exactly and rounded once; discountMinor is their difference.
    const rate = MathBN.div(rates, 100)
    for (const adjustment of present(charged.adjustments)) {
      const code = nonEmpty(adjustment.code)
      if (!code) continue
      const net = adjustment.is_tax_inclusive
        ? MathBN.div(adjustment.raw_amount.value, MathBN.add(1, rate)) : MathBN.convert(adjustment.raw_amount.value)
      const tax = MathBN.mult(net, rate)
      const entry = coupons.get(code) ?? { gross: MathBN.convert(0), tax: MathBN.convert(0) }
      coupons.set(code, { gross: MathBN.add(entry.gross, net, tax), tax: MathBN.add(entry.tax, tax) })
    }
  }

  const payments = present(row.payment_collections).flatMap(collection => present(collection.payments))
    .filter(payment => payment.canceled_at == null)
  const kind = payments.length === 1 ? tillKind(metadata) : undefined
  const discount = split(row.raw_discount_total, row.raw_discount_tax_total, decimals)

  return {
    id: row.id,
    reference: String(row.display_id),
    ...(typeof metadata.tally_client_id === 'string' ? { clientOrderId: metadata.tally_client_id } : {}),
    status: row.status,
    placedAt: new Date(tillCreatedAt ?? row.created_at).toISOString(),
    currency: row.currency_code,
    pricesIncludeTax: items.length > 0 && items.every(item => item.is_tax_inclusive === true),
    customer: customerId || name || email
      ? { ...(customerId ? { id: customerId } : {}), ...(name ? { name } : {}), ...(email ? { email } : {}) } : null,
    lines: items.filter(item => !isFee(item)).map((item): StoreOrderLine => {
      const before = split(item.raw_original_total, item.raw_original_tax_total, decimals)
      const after = split(item.raw_total, item.raw_tax_total, decimals)
      const clientLineId = nonEmpty(item.metadata?.tally_line_uuid)
      const productId = nonEmpty(item.product_id), variantId = nonEmpty(item.variant_id), sku = nonEmpty(item.variant_sku)
      return {
        id: item.id, ...(clientLineId ? { clientLineId } : {}), ...(productId ? { productId } : {}),
        ...(variantId ? { variantId } : {}), name: item.title, ...(sku ? { sku } : {}), quantity: Number(item.raw_quantity.value),
        subtotalMinor: before.netMinor, subtotalTaxMinor: before.taxMinor, totalMinor: after.netMinor, taxMinor: after.taxMinor,
      }
    }),
    fees: items.filter(isFee).map(item => charge(item.title, item, decimals)),
    shipping: shippingMethods.map(method => charge(method.name, method, decimals)),
    coupons: [...coupons].map(([code, { gross, tax }]) => {
      const { netMinor, taxMinor } = split(gross.toFixed(), tax.toFixed(), decimals)
      return { code, discountMinor: netMinor, discountTaxMinor: taxMinor }
    }),
    taxLines: [...taxes.values()].map(({ amount, ...line }) => ({ ...line, amountMinor: majorToMinor(amount.toFixed(), decimals) })),
    discountMinor: discount.netMinor,
    discountTaxMinor: discount.taxMinor,
    taxMinor: majorToMinor(row.raw_tax_total.value, decimals),
    totalMinor: majorToMinor(row.raw_total.value, decimals),
    // Medusa records no provider name, so title is left out.
    payments: payments.map((payment): StoreOrderPayment => ({
      method: payment.provider_id, ...(kind ? { kind } : {}), amountMinor: majorToMinor(payment.raw_amount.value, decimals),
    })),
    refunds: payments.flatMap(payment => present(payment.refunds)).map(refund => {
      const reason = nonEmpty(refund.note) ?? nonEmpty(refund.refund_reason?.label)
      return { id: refund.id, amountMinor: Math.abs(majorToMinor(refund.raw_amount.value, decimals)), ...(reason ? { reason } : {}) }
    }),
  }
}

export function orderPage(rows: OrderRow[], count: number, query: OrdersQuery): StoreOrderPage {
  const orders = rows.map(toStoreOrder)
  return { orders, hasMore: (query.page - 1) * query.perPage + orders.length < count, total: count }
}
