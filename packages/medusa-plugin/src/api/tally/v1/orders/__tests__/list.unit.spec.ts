import { orderFilters, orderPage, parseOrdersQuery, refundLinesById, toStoreOrder, type OrderRow } from '../list'

const raw = (value: string | number) => ({ value })
const vat19 = { rate: 19, code: 'VAT19', description: 'VAT' }
// The gross of a query.graph row rounded once, to EUR cents.
const grossCents = (row: { raw_total: { value: string | number } }) => Math.round(Number(row.raw_total.value) * 100)

describe('parseOrdersQuery', () => {
  it('parses ids as 1 to 100 comma-separated order ids', () => {
    for (const ids of [['order_a', 'order_b'], ['b', ' a', 'b'], Array.from({ length: 100 }, (_, index) => `order_${index}`)]) {
      expect(parseOrdersQuery({ ids: ids.join(',') })).toMatchObject({ ok: true, query: { ids } })
    }
  })

  it('refuses an empty id, an empty list, 101 ids or a repeated ids', () => {
    for (const ids of ['', 'a,,b', 'a,', Array(101).fill('order').join(',')]) {
      expect(parseOrdersQuery({ ids })).toEqual({ ok: false, error: { code: 'invalid_query', message: 'ids must be 1 to 100 comma-separated order ids' } })
    }
    expect(parseOrdersQuery({ ids: ['a', 'b'] })).toEqual({ ok: false, error: { code: 'invalid_query', message: 'expected one string value for: ids' } })
  })

  it('defaults to page 1 of 25 with allChannels false', () => {
    expect(parseOrdersQuery({})).toEqual({ ok: true, query: { page: 1, perPage: 25, allChannels: false } })
  })

  it('accepts allChannels true and false', () => {
    expect(parseOrdersQuery({ allChannels: 'true' })).toMatchObject({ ok: true, query: { allChannels: true } })
    expect(parseOrdersQuery({ allChannels: 'false' })).toMatchObject({ ok: true, query: { allChannels: false } })
  })

  it.each(['1', ''])('refuses allChannels=%j', allChannels => {
    expect(parseOrdersQuery({ allChannels })).toEqual({
      ok: false, error: { code: 'invalid_query', message: 'allChannels must be true or false' },
    })
  })

  it('clamps perPage to 1..100', () => {
    expect(parseOrdersQuery({ perPage: '0' })).toMatchObject({ ok: true, query: { perPage: 1 } })
    expect(parseOrdersQuery({ perPage: '500' })).toMatchObject({ ok: true, query: { perPage: 100 } })
  })

  it.each([{ page: 'abc' }, { page: '0' }, { page: '1.5' }, { perPage: '-3' }, { after: 'yesterday' },
    { before: '2026-11-11T00:00:00+01:00' }, { page: ['1', '2'] }, { search: { $ne: '' } }])(
    'refuses a malformed value %j as invalid_query', value => {
      expect(parseOrdersQuery(value)).toMatchObject({ ok: false, error: { code: 'invalid_query' } })
    })

  it('refuses after later than before', () => {
    expect(parseOrdersQuery({ after: '2026-11-12T00:00:00Z', before: '2026-11-11T00:00:00.000Z' }))
      .toMatchObject({ ok: false, error: { code: 'invalid_query' } })
  })

  it('keeps a valid date range and the plain filters', () => {
    expect(parseOrdersQuery({ page: '2', perPage: '10', search: 'ann', status: 'pending', customerId: 'cus_1',
      registerId: 'reg_1', after: '2026-11-11T00:00:00Z', before: '2026-11-12T00:00:00.000Z' })).toEqual({ ok: true, query: {
      page: 2, perPage: 10, allChannels: false, search: 'ann', status: 'pending', customerId: 'cus_1', registerId: 'reg_1',
      dateRange: { after: '2026-11-11T00:00:00Z', before: '2026-11-12T00:00:00.000Z' },
    } })
  })

  it('refuses unsupported core filters by name, in core order', () => {
    expect(parseOrdersQuery({ createdVia: 'checkout', cashierId: 'user_1' }))
      .toEqual({ ok: false, error: { code: 'unsupported_order_filter', fields: ['cashierId', 'createdVia'] } })
  })

  it('refuses a parameter outside the query', () => {
    expect(parseOrdersQuery({ fields: '*' })).toMatchObject({ ok: false, error: { code: 'invalid_query' } })
  })
})

describe('orderFilters', () => {
  const query = (extra: object) => ({ page: 1, perPage: 25, allChannels: false, ...extra })

  it('scopes to the channel and leaves drafts out', () => {
    expect(orderFilters(query({}), { salesChannelId: 'sc_1' })).toEqual({ sales_channel_id: 'sc_1', is_draft_order: false })
  })

  it('filters by ids alongside the channel and other filters', () => {
    const ids = ['order_b', 'order_a']
    expect(orderFilters(query({ ids, status: 'pending', search: '42' }), { salesChannelId: 'sc_1' })).toEqual({
      id: ids, sales_channel_id: 'sc_1', is_draft_order: false, status: 'pending', display_id: 42,
    })
  })

  it('lists all channels while leaving drafts out and keeping the register filter', () => {
    expect(orderFilters(query({ allChannels: true, registerId: 'reg_1' }), 'all')).toEqual({
      is_draft_order: false, metadata: { tally_register_id: 'reg_1' },
    })
  })

  it('maps the filters to order fields', () => {
    expect(orderFilters(query({ status: 'pending', customerId: 'cus_1', registerId: 'reg_1',
      dateRange: { after: '2026-11-11T00:00:00Z', before: '2026-11-12T00:00:00Z' } }), { salesChannelId: 'sc_1' })).toEqual({
      sales_channel_id: 'sc_1', is_draft_order: false, status: 'pending', customer_id: 'cus_1',
      metadata: { tally_register_id: 'reg_1' }, created_at: { $gte: '2026-11-11T00:00:00Z', $lt: '2026-11-12T00:00:00Z' },
    })
  })

  it('searches a number as the display id and anything else with the order search', () => {
    expect(orderFilters(query({ search: ' 42 ' }), { salesChannelId: 'sc_1' })).toMatchObject({ display_id: 42 })
    expect(orderFilters(query({ search: 'ann@example.com' }), { salesChannelId: 'sc_1' })).toMatchObject({ q: 'ann@example.com' })
    expect(orderFilters(query({ search: '99999999999' }), { salesChannelId: 'sc_1' })).toBeNull()
    expect(orderFilters(query({ search: '  ' }), { salesChannelId: 'sc_1' })).toEqual({ sales_channel_id: 'sc_1', is_draft_order: false })
  })

  it('matches nothing for an empty filter value', () => {
    expect(orderFilters(query({ status: '' }), { salesChannelId: 'sc_1' })).toBeNull()
    expect(orderFilters(query({ registerId: '' }), { salesChannelId: 'sc_1' })).toBeNull()
  })
})

// EUR, prices excluding tax. Tea: 2 × 10.00 at 19 %, less coupon SAVE10 (2.00 net). Biscuit: 3.333 net, so its gross
// 3.96627 rounds to 3.97 while net and tax rounded apart (3.33 + 0.63) would give 3.96. A 1.00 fee at 19 %, and 5.00
// shipping at 7 %.
const tillOrder: OrderRow = {
  id: 'order_1', display_id: 41, status: 'pending', created_at: new Date('2026-11-19T10:00:05.000Z'), currency_code: 'eur',
  email: 'ann@example.com', customer_id: 'cus_1',
  customer: { id: 'cus_1', first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com' },
  metadata: { tally_client_id: 'pos-order-1', tally_created_at: '2026-11-19T10:00:00.000Z',
    tally_payments: [{ clientPaymentId: 'pay-1', method: 'cash', amountMinor: 3193 }] },
  raw_total: raw('31.92627'), raw_tax_total: raw('4.59327'), raw_discount_total: raw('2.38'), raw_discount_tax_total: raw('0.38'),
  items: [
    { id: 'item_a', title: 'Tea', product_id: 'prod_tea', variant_id: 'var_tea', variant_sku: 'TEA-1', raw_quantity: raw('2'),
      is_tax_inclusive: false, metadata: { tally_line_uuid: 'line-a' }, raw_original_total: raw('23.8'),
      raw_original_tax_total: raw('3.8'), raw_total: raw('21.42'), raw_tax_total: raw('3.42'), tax_lines: [vat19],
      adjustments: [{ code: 'SAVE10', raw_amount: raw('2'), is_tax_inclusive: false }] },
    { id: 'item_b', title: 'Biscuit', product_id: 'prod_b', variant_id: 'var_b', variant_sku: null, raw_quantity: raw(1),
      is_tax_inclusive: false, metadata: { tally_line_uuid: 'line-b' }, raw_original_total: raw('3.96627'),
      raw_original_tax_total: raw('0.63327'), raw_total: raw('3.96627'), raw_tax_total: raw('0.63327'), tax_lines: [vat19],
      adjustments: [] },
    { id: 'item_fee', title: 'Service fee', raw_quantity: raw(1), is_tax_inclusive: false, metadata: { tally_fee_uuid: 'fee-1' },
      raw_original_total: raw('1.19'), raw_original_tax_total: raw('0.19'), raw_total: raw('1.19'), raw_tax_total: raw('0.19'),
      tax_lines: [vat19], adjustments: [] },
  ],
  shipping_methods: [
    { name: 'Courier', raw_total: raw('5.35'), raw_tax_total: raw('0.35'),
      tax_lines: [{ rate: 7, code: 'VAT7', description: 'VAT reduced' }], adjustments: [] },
  ],
  payment_collections: [{ payments: [
    { id: 'pay_1', provider_id: 'pp_system_default', raw_amount: raw('31.93'), canceled_at: null,
      refunds: [{ id: 'ref_1', raw_amount: raw('1.19'), note: null, refund_reason: { label: 'Damaged' } }] },
    { id: 'pay_void', provider_id: 'pp_system_default', raw_amount: raw('31.93'), canceled_at: '2026-11-19T09:59:00.000Z' },
  ] }],
}

function expectGrossRoundedOnce(order: OrderRow, mapped: ReturnType<typeof toStoreOrder>) {
  const items = order.items!.filter(item => item!.metadata?.tally_fee_uuid === undefined)
  const fees = order.items!.filter(item => item!.metadata?.tally_fee_uuid !== undefined)
  mapped.lines.forEach((line, i) => {
    expect(line.totalMinor + line.taxMinor).toBe(grossCents(items[i]!))
    expect(line.subtotalMinor + line.subtotalTaxMinor).toBe(Math.round(Number(items[i]!.raw_original_total.value) * 100))
  })
  mapped.fees.forEach((fee, i) => expect(fee.totalMinor + fee.taxMinor).toBe(grossCents(fees[i]!)))
  mapped.shipping.forEach((method, i) => expect(method.totalMinor + method.taxMinor).toBe(grossCents(order.shipping_methods![i]!)))
}

describe('refundLinesById', () => {
  it('L1: maps stored lines without restock and leaves out a zero quantity', () => {
    const line = { orderLineId: 'item_a', quantity: 1, netMinor: 99, taxMinor: 19 }
    const zero = { ...line, quantity: 0 }
    expect(refundLinesById([
      { medusa_refund_id: 'paid', lines: [{ ...line, restock: true }, zero, { ...line, quantity: 1.5 }] },
      { medusa_refund_id: 'invalid', lines: {} }, { medusa_refund_id: 'empty', lines: [zero] },
    ])).toEqual(new Map([['paid', [line]]]))
  })
})

describe('toStoreOrder', () => {
  const refunded = { ...tillOrder, payment_collections: [{ payments: [{ id: 'payment', provider_id: 'cash', raw_amount: raw(10),
    refunds: ['first', 'second', 'admin'].map(id => ({ id, raw_amount: raw(1), note: id })) }] }] }
  const firstLine = { orderLineId: 'item_a', quantity: 2, netMinor: 90, taxMinor: 10 }
  const secondLine = { orderLineId: 'item_b', quantity: 1, netMinor: 95, taxMinor: 5 }
  const bare = ['first', 'second', 'admin'].map(id => ({ id, amountMinor: 100, reason: id }))

  it("R1: puts each till refund's lines on its refund and none on an Admin refund", () => {
    const lines = new Map([['second', [secondLine]], ['first', [firstLine]]])
    expect(toStoreOrder(refunded, lines).refunds).toStrictEqual([
      { ...bare[0], lines: [firstLine] }, { ...bare[1], lines: [secondLine] }, bare[2],
    ])
  })

  it('R2: carries no lines on any refund when together they name more of a line than was ordered', () => {
    for (const orderLineId of ['item_a', 'unknown', 'item_fee']) {
      const lines = new Map([['first', [firstLine]], ['second', [{ ...secondLine, orderLineId }]]])
      expect(toStoreOrder(refunded, lines).refunds).toStrictEqual(bare)
    }
  })

  it('maps a tax-exclusive till order', () => {
    const mapped = toStoreOrder(tillOrder)
    expect(mapped).toEqual({
      id: 'order_1', reference: '41', clientOrderId: 'pos-order-1', status: 'pending', placedAt: '2026-11-19T10:00:00.000Z',
      currency: 'eur', pricesIncludeTax: false, customer: { id: 'cus_1', name: 'Ann Lee', email: 'ann@example.com' },
      lines: [
        { id: 'item_a', clientLineId: 'line-a', productId: 'prod_tea', variantId: 'var_tea', name: 'Tea', sku: 'TEA-1',
          quantity: 2, subtotalMinor: 2000, subtotalTaxMinor: 380, totalMinor: 1800, taxMinor: 342,
          soldTotalMinor: 1800, soldTaxMinor: 342, returnedQuantity: 0 },
        { id: 'item_b', clientLineId: 'line-b', productId: 'prod_b', variantId: 'var_b', name: 'Biscuit',
          quantity: 1, subtotalMinor: 334, subtotalTaxMinor: 63, totalMinor: 334, taxMinor: 63,
          // Gross 3.96627 with tax 0.63327: refund net round(3.333 EUR) = 333 cents, tax 397 − 333 = 64, against live 334/63.
          soldTotalMinor: 333, soldTaxMinor: 64, returnedQuantity: 0 },
      ],
      fees: [{ name: 'Service fee', totalMinor: 100, taxMinor: 19 }],
      shipping: [{ name: 'Courier', totalMinor: 500, taxMinor: 35 }],
      // 2.00 net plus 19 % tax: gross 2.38.
      coupons: [{ code: 'SAVE10', discountMinor: 200, discountTaxMinor: 38 }],
      // 3.42 + 0.63327 + 0.19 at 19 %; 0.35 at 7 %.
      taxLines: [
        { label: 'VAT', code: 'VAT19', ratePpm: 190000, amountMinor: 424 },
        { label: 'VAT reduced', code: 'VAT7', ratePpm: 70000, amountMinor: 35 },
      ],
      discountMinor: 200, discountTaxMinor: 38, taxMinor: 459, totalMinor: 3193,
      payments: [{ method: 'pp_system_default', kind: 'cash', amountMinor: 3193 }],
      refunds: [{ id: 'ref_1', amountMinor: 119, reason: 'Damaged' }],
    })
    expectGrossRoundedOnce(tillOrder, mapped)
  })

  it('U-C7-1: preserves the discounted as-sold figures after a received return and leaves fees unchanged', () => {
    const item = { id: 'tea', title: 'Tea', quantity: 2, raw_quantity: raw(2), raw_unit_price: raw('10'), is_tax_inclusive: true,
      raw_original_total: raw('20'), raw_original_tax_total: raw('3.193277'), raw_total: raw('9.52'), raw_tax_total: raw('1.52'),
      tax_lines: [vat19], adjustments: [{ code: 'SAVE', raw_amount: raw('0.96'), is_tax_inclusive: true }],
      detail: { return_received_quantity: 1 } }
    const mapped = toStoreOrder({ ...tillOrder, items: [item, tillOrder.items![2]] })
    // Sold gross = 2 × 10 − 0.96 = 19.04; net = 19.04 / 1.19 = 16.00 and tax = 3.04. The live split is half.
    expect(mapped.lines).toMatchObject([{ totalMinor: 800, taxMinor: 152, soldTotalMinor: 1600, soldTaxMinor: 304, returnedQuantity: 1 }])
    expect(mapped.fees).toEqual([{ name: 'Service fee', totalMinor: 100, taxMinor: 19 }])
  })

  it('U-C7-2: without a unit price or return detail, uses the refund split of the live gross', () => {
    const mapped = toStoreOrder({ ...tillOrder, items: [tillOrder.items![1]] })
    // Gross 3.96627 with tax 0.63327: refund net round(3.333 EUR) = 333 cents, tax 397 − 333 = 64, against live 334/63.
    expect(mapped.lines).toMatchObject([{ totalMinor: 334, taxMinor: 63, soldTotalMinor: 333, soldTaxMinor: 64, returnedQuantity: 0 }])
  })

  // EUR, prices including tax. Coffee 11.90 at 19 % less coupon INCL5 (1.19 gross); Cake 12.00 under two rates (15 % and
  // 5 %), whose 2.00 tax splits by rate; Mug 9.99 at 19 %, whose tax 1.59504… rounds to 1.60 and net to 8.39.
  const inclusiveOrder: OrderRow = {
    ...tillOrder, id: 'order_2', display_id: 42, raw_total: raw('32.7'), raw_tax_total: raw('5.305042016806722689'),
    raw_discount_total: raw('1.19'), raw_discount_tax_total: raw('0.19'), shipping_methods: [],
    metadata: { tally_client_id: 'pos-order-2', tally_created_at: '2026-11-19T11:00:00.000Z' },
    items: [
      { id: 'item_c', title: 'Coffee', raw_quantity: raw(1), is_tax_inclusive: true, raw_original_total: raw('11.9'),
        raw_original_tax_total: raw('1.9'), raw_total: raw('10.71'), raw_tax_total: raw('1.71'), tax_lines: [vat19],
        adjustments: [{ code: 'INCL5', raw_amount: raw('1.19'), is_tax_inclusive: true }] },
      { id: 'item_d', title: 'Cake', raw_quantity: raw(1), is_tax_inclusive: true, raw_original_total: raw('12'),
        raw_original_tax_total: raw('2'), raw_total: raw('12'), raw_tax_total: raw('2'),
        tax_lines: [{ rate: 15, code: 'GST', description: 'State tax' }, { rate: 5, code: 'CITY', description: 'City tax' }] },
      { id: 'item_e', title: 'Mug', raw_quantity: raw(1), is_tax_inclusive: true, raw_original_total: raw('9.99'),
        raw_original_tax_total: raw('1.595042016806722689'), raw_total: raw('9.99'), raw_tax_total: raw('1.595042016806722689'),
        tax_lines: [vat19] },
    ],
    payment_collections: [{ payments: [{ id: 'pay_2', provider_id: 'pp_system_default', raw_amount: raw('32.7') }] }],
  }

  it('maps a tax-inclusive order', () => {
    const mapped = toStoreOrder(inclusiveOrder)
    expect(mapped).toMatchObject({
      pricesIncludeTax: true,
      lines: [
        { id: 'item_c', subtotalMinor: 1000, subtotalTaxMinor: 190, totalMinor: 900, taxMinor: 171 },
        { id: 'item_d', subtotalMinor: 1000, subtotalTaxMinor: 200, totalMinor: 1000, taxMinor: 200 },
        { id: 'item_e', subtotalMinor: 839, subtotalTaxMinor: 160, totalMinor: 839, taxMinor: 160 },
      ],
      // 1.19 gross is 1.00 net and 0.19 tax at 19 %.
      coupons: [{ code: 'INCL5', discountMinor: 100, discountTaxMinor: 19 }],
      taxLines: [
        { label: 'VAT', code: 'VAT19', ratePpm: 190000, amountMinor: 331 },
        { label: 'State tax', code: 'GST', ratePpm: 150000, amountMinor: 150 },
        { label: 'City tax', code: 'CITY', ratePpm: 50000, amountMinor: 50 },
      ],
      discountMinor: 100, discountTaxMinor: 19, taxMinor: 531, totalMinor: 3270,
      // No tally_payments: the till's kind is not known.
      payments: [{ method: 'pp_system_default', amountMinor: 3270 }],
    })
    expect(mapped.payments[0]).not.toHaveProperty('kind')
    expect(mapped.lines.map(line => line.clientLineId)).toEqual([undefined, undefined, undefined])
    expectGrossRoundedOnce(inclusiveOrder, mapped)
  })

  it('maps an order no till created', () => {
    const mapped = toStoreOrder({
      id: 'order_web', display_id: 7, status: 'completed', created_at: new Date('2026-11-18T08:30:00.000Z'),
      currency_code: 'eur', email: null, customer_id: null, customer: null, metadata: null,
      raw_total: raw(0), raw_tax_total: raw(0), raw_discount_total: raw(0), raw_discount_tax_total: raw(0),
      items: [], shipping_methods: [], payment_collections: [],
    })
    expect(mapped).not.toHaveProperty('clientOrderId')
    expect(mapped).toMatchObject({ reference: '7', placedAt: '2026-11-18T08:30:00.000Z', customer: null,
      pricesIncludeTax: false, payments: [], refunds: [] })
  })

  it('leaves the kind out when the till recorded more than one kind', () => {
    const mapped = toStoreOrder({ ...tillOrder, metadata: { tally_payments: [{ method: 'cash' }, { method: 'external' }] } })
    expect(mapped.payments).toEqual([{ method: 'pp_system_default', amountMinor: 3193 }])
  })
})

describe('orderPage', () => {
  it('says whether more orders follow the page', () => {
    expect(orderPage([tillOrder], 2, { page: 1, perPage: 1, allChannels: false })).toMatchObject({ hasMore: true, total: 2 })
    expect(orderPage([tillOrder], 2, { page: 2, perPage: 1, allChannels: false })).toMatchObject({ hasMore: false, total: 2 })
    expect(orderPage([], 0, { page: 1, perPage: 25, allChannels: false })).toEqual({ orders: [], hasMore: false, total: 0 })
  })
})
