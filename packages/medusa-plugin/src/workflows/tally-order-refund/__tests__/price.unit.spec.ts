import { connectorSplit, medusaSumMinor, priceRefund, refundMoneyMinor, type PriceRefundInput } from '../price'

const request = (overrides: Partial<PriceRefundInput['request']>): PriceRefundInput['request'] =>
  ({ lines: [], shippingMinor: 0, adjustmentMinor: 0, totalMinor: 0, ...overrides })
const line = { id: 'ordli_1', quantity: 3, returnedQuantity: 0, netMinor: 1000, taxMinor: 190 }
// The order's payment: the line's 1190 gross and 500 shipping.
const base: Omit<PriceRefundInput, 'request'> = { lines: [line], linesMoneyMinor: 1190, shippingMinor: 500, earlier: [], paidMinor: 1690, outsideRefundsMinor: 0, refundableMoneyMinor: 1690 }

describe('priceRefund (pos priceRefund on the connector split, ADR 0026 decision 5)', () => {
  it("P1: prices from the connector's round(gross − tax), not round(gross) − round(tax)", () => {
    // gross 10.004, tax 1.665 at 2 decimals: the two rules split the same 1000 differently.
    expect(connectorSplit('10.004', '1.665', 2)).toEqual({ netMinor: 834, taxMinor: 166 })
    const listRule = { netMinor: medusaSumMinor(2, ['10.004']) - medusaSumMinor(2, ['1.665']), taxMinor: medusaSumMinor(2, ['1.665']) }
    expect(listRule).toEqual({ netMinor: 833, taxMinor: 167 })
    const lines = [{ id: 'ordli_1', quantity: 3, returnedQuantity: 0, ...connectorSplit('10.004', '1.665', 2) }]
    const one = [{ orderLineId: 'ordli_1', quantity: 1, restock: true }]
    // One unit of three: connector 278 + 55 = 333; the list rule would give 278 + 56 = 334.
    expect(priceRefund({ ...base, lines, linesMoneyMinor: 1000, request: request({ lines: one, totalMinor: 333 }) }))
      .toEqual({ ok: true, totalMinor: 333, lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true, netMinor: 278, taxMinor: 55 }] })
    expect(priceRefund({ ...base, lines, linesMoneyMinor: 1000, request: request({ lines: one, totalMinor: 334 }) })).toEqual({ ok: false, error: {
      code: 'amount_mismatch', message: "The refund total differs from the store's.", data: { expectedMinor: 334, serverMinor: 333 } } })
    // The spec's example (10.005 / 1.6675) rounds to the same split under both rules.
    expect(connectorSplit('10.005', '1.6675', 2)).toEqual({ netMinor: 834, taxMinor: 167 })
  })

  it('sums decimals exactly, also with exponents and zero-decimal currencies', () => {
    expect(medusaSumMinor(2, ['0.1', '0.2'], ['0.3'])).toBe(0)
    expect(medusaSumMinor(2, ['-1.005'])).toBe(-101)
    expect(medusaSumMinor(2, [1e-7, '1.5e1'])).toBe(1500)
    expect(medusaSumMinor(0, ['1999.5'])).toBe(2000)
    expect(() => medusaSumMinor(2, ['abc'])).toThrow(RangeError)
  })

  it('P2: three one-unit refunds of a 3-unit line add up to its net and tax exactly', () => {
    const earlier: PriceRefundInput['earlier'] = []
    const taken: { netMinor: number; taxMinor: number }[] = []
    let refundableMoneyMinor = 1690
    for (const totalMinor of [396, 398, 396]) {
      const result = priceRefund({ ...base, earlier, refundableMoneyMinor,
        request: request({ lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true }], totalMinor }) })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      taken.push(result.lines[0])
      refundableMoneyMinor -= result.totalMinor
      earlier.push({ lines: result.lines, shippingMinor: 0, medusaRefundId: 'refund_1' })
    }
    expect(taken.map(({ netMinor, taxMinor }) => [netMinor, taxMinor])).toEqual([[333, 63], [334, 64], [333, 63]])
    expect(taken.reduce((sum, row) => sum + row.netMinor, 0)).toBe(1000)
    expect(taken.reduce((sum, row) => sum + row.taxMinor, 0)).toBe(190)
  })

  it('P3: a quantity above the refundable one, or an unknown line, is quantity_exceeds', () => {
    const earlier = [{ lines: [{ orderLineId: 'ordli_1', quantity: 2, restock: true, netMinor: 667, taxMinor: 127 }], shippingMinor: 0, medusaRefundId: 'refund_1' }]
    expect(priceRefund({ ...base, earlier, request: request({ totalMinor: 1, lines: [
      { orderLineId: 'ordli_1', quantity: 2, restock: true }, { orderLineId: 'ordli_x', quantity: 1, restock: false },
    ] }) })).toEqual({ ok: false, error: { code: 'quantity_exceeds',
      message: 'A line asks for more than its refundable quantity, or is not on the order.',
      data: { lines: [{ orderLineId: 'ordli_1', quantity: 2, refundableQuantity: 1 }, { orderLineId: 'ordli_x', quantity: 1, refundableQuantity: 0 }] } } })
  })

  it('refuses shipping above what is left, a total above the money left, and nothing to refund', () => {
    const shippingDone = [{ lines: [], shippingMinor: 300, medusaRefundId: 'refund_1' }]
    expect(priceRefund({ ...base, earlier: shippingDone, request: request({ shippingMinor: 300, totalMinor: 300 }) }))
      .toMatchObject({ ok: false, error: { code: 'amount_mismatch', data: { expectedMinor: 300, serverMinor: 200 } } })
    expect(priceRefund({ ...base, earlier: shippingDone, request: request({ shippingMinor: 200, totalMinor: 200 }) }))
      .toEqual({ ok: true, lines: [], totalMinor: 200 })
    expect(priceRefund({ ...base, refundableMoneyMinor: 250, request: request({ shippingMinor: 300, totalMinor: 300 }) }))
      .toMatchObject({ ok: false, error: { code: 'amount_mismatch', data: { expectedMinor: 300, serverMinor: 250 } } })
    expect(priceRefund({ ...base, request: request({ adjustmentMinor: 50, totalMinor: 50 }) })).toEqual({ ok: true, lines: [], totalMinor: 50 })
    for (const input of [{ ...base, request: request({}) }, { ...base, linesMoneyMinor: null, refundableMoneyMinor: null, request: request({ shippingMinor: 1, totalMinor: 1 }) },
      { ...base, request: request({ adjustmentMinor: 0, shippingMinor: 0, lines: [], totalMinor: 0 }) }]) {
      expect(priceRefund(input)).toMatchObject({ ok: false, error: { code: 'nothing_to_refund' } })
    }
  })
})

// The remainder rule (ADR 0026 decision 5, desk ruling 2026-11-23): three one-unit lines at 0.99 ex 19% (gross 1.1781 each),
// paid 3.53. Each line prices at 1.18, so the per-line sum is 3.54, one more than was paid.
describe('the last units take the remainder', () => {
  const lines = ['ordli_a', 'ordli_b', 'ordli_c'].map(id => ({ id, quantity: 1, returnedQuantity: 0, ...connectorSplit('1.1781', '0.1881', 2) }))
  const order = { lines, linesMoneyMinor: 353, shippingMinor: 0, earlier: [] as PriceRefundInput['earlier'], paidMinor: 353, outsideRefundsMinor: 0, refundableMoneyMinor: 353 }
  const take = (...ids: string[]) => ids.map(orderLineId => ({ orderLineId, quantity: 1, restock: true }))

  it('R1: refunding all three lines prices at 353, the payment, not the per-line 354', () => {
    expect(lines[0]).toMatchObject({ netMinor: 99, taxMinor: 19 })
    const perLine = lines.reduce((sum, line) => sum + line.netMinor + line.taxMinor, 0)
    expect(perLine).toBe(354)
    const result = priceRefund({ ...order, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 353 }) })
    // The one-unit difference goes on the net of the request's last line, so the lines still sum to the total.
    expect(result).toEqual({ ok: true, totalMinor: 353, lines: [
      { orderLineId: 'ordli_a', quantity: 1, restock: true, netMinor: 99, taxMinor: 19 },
      { orderLineId: 'ordli_b', quantity: 1, restock: true, netMinor: 99, taxMinor: 19 },
      { orderLineId: 'ordli_c', quantity: 1, restock: true, netMinor: 98, taxMinor: 19 },
    ] })
    // The till's per-line 354 is more than was paid: refused with the server's 353.
    expect(priceRefund({ ...order, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 354 }) }))
      .toMatchObject({ ok: false, error: { code: 'amount_mismatch', data: { expectedMinor: 354, serverMinor: 353 } } })
  })

  it('R2: two lines price at the per-line 236; the last line then takes the remainder, 117; together 353', () => {
    const first = priceRefund({ ...order, request: request({ lines: take('ordli_a', 'ordli_b'), totalMinor: 236 }) })
    expect(first).toMatchObject({ ok: true, totalMinor: 236 })
    const earlier = [{ lines: take('ordli_a', 'ordli_b').map(line => ({ ...line, netMinor: 99, taxMinor: 19 })), shippingMinor: 0, medusaRefundId: 'refund_1' }]
    const last = priceRefund({ ...order, earlier, refundableMoneyMinor: 353 - 236,
      request: request({ lines: take('ordli_c'), totalMinor: 117 }) })
    expect(last).toEqual({ ok: true, totalMinor: 117,
      lines: [{ orderLineId: 'ordli_c', quantity: 1, restock: true, netMinor: 98, taxMinor: 19 }] })
    expect((first as { totalMinor: number }).totalMinor + (last as { totalMinor: number }).totalMinor).toBe(353)
  })

  it('D-drift (R3): a remainder more than one minor unit per line from the per-line sum is order_state', () => {
    // 3 lines allow 3 units: 351 (3 below 354) is rounding, 350 (4 below) is not.
    expect(priceRefund({ ...order, linesMoneyMinor: 351, refundableMoneyMinor: 351, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 351 }) }))
      .toMatchObject({ ok: true, totalMinor: 351 })
    expect(priceRefund({ ...order, linesMoneyMinor: 350, refundableMoneyMinor: 350, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 350 }) }))
      .toEqual({ ok: false, error: { code: 'order_state', message: expect.any(String), data: { state: 'money_drift' } } })
    expect(priceRefund({ ...order, linesMoneyMinor: 358, refundableMoneyMinor: 358, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 358 }) }))
      .toEqual({ ok: false, error: { code: 'order_state', message: expect.any(String), data: { state: 'money_drift' } } })
  })

  it('A-fee: the three product lines take 353 of the 472 payment, excluding the gross 119 fee', () => {
    // The line money comes from the order's raw figures, so a fee left in it (472 against 354) would be money drift.
    const money = refundMoneyMinor(2, '4.72', [], ['1.19'])
    expect(money).toEqual({ linesMoneyMinor: 353, shippingMinor: 0 })
    expect(priceRefund({ ...order, ...money, refundableMoneyMinor: 472,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 353 }) }))
      .toEqual({ ok: true, totalMinor: 353, lines: [
        { ...take('ordli_a')[0], netMinor: 99, taxMinor: 19 }, { ...take('ordli_b')[0], netMinor: 99, taxMinor: 19 },
        { ...take('ordli_c')[0], netMinor: 98, taxMinor: 19 },
      ] })
  })

  it('A-goodwill: an earlier adjustment of 1 never enters the lines remainder', () => {
    const earlier = [{ lines: [], shippingMinor: 0, adjustmentMinor: 1, totalMinor: 1, medusaRefundId: 'refund_1' }]
    expect(priceRefund({ ...order, shippingMinor: 500, earlier, refundableMoneyMinor: 852,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 353 }) }))
      .toMatchObject({ ok: true, totalMinor: 353 })
  })

  it('A-withheld: an earlier 118 line with adjustment -3 and total 115 leaves 235 in line money', () => {
    const earlier = [{ lines: [{ ...take('ordli_a')[0], netMinor: 99, taxMinor: 19 }],
      shippingMinor: 0, adjustmentMinor: -3, totalMinor: 115, medusaRefundId: 'refund_1' }]
    expect(priceRefund({ ...order, earlier, refundableMoneyMinor: 238,
      request: request({ lines: take('ordli_b', 'ordli_c'), totalMinor: 235 }) }))
      .toEqual({ ok: true, totalMinor: 235, lines: [
        { ...take('ordli_b')[0], netMinor: 99, taxMinor: 19 }, { ...take('ordli_c')[0], netMinor: 98, taxMinor: 19 },
      ] })
  })

  it('B-free-last: the -1 goes on the earlier net when the last line is free; no net is negative', () => {
    const withFree = [lines[0], { ...lines[1], netMinor: 0, taxMinor: 0 }]
    const result = priceRefund({ ...order, lines: withFree, linesMoneyMinor: 117, refundableMoneyMinor: 117,
      request: request({ lines: take('ordli_a', 'ordli_b'), totalMinor: 117 }) })
    expect(result).toEqual({ ok: true, totalMinor: 117, lines: [
      { ...take('ordli_a')[0], netMinor: 98, taxMinor: 19 }, { ...take('ordli_b')[0], netMinor: 0, taxMinor: 0 },
    ] })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.lines.every(line => line.netMinor >= 0)).toBe(true)
  })

  it('B-largest: +2 with no covering net goes on the largest, ties to the later line', () => {
    const small = lines.map((line, index) => ({ ...line, netMinor: index === 2 ? 0 : 1, taxMinor: 0 }))
    expect(priceRefund({ ...order, lines: small, linesMoneyMinor: 4, refundableMoneyMinor: 4,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 4 }) }))
      .toEqual({ ok: true, totalMinor: 4, lines: [
        { ...take('ordli_a')[0], netMinor: 1, taxMinor: 0 }, { ...take('ordli_b')[0], netMinor: 3, taxMinor: 0 },
        { ...take('ordli_c')[0], netMinor: 0, taxMinor: 0 },
      ] })
  })

  it('N1-tax: a negative difference no net covers goes on the largest gross tax, ties later', () => {
    expect(priceRefund({ ...order, lines: lines.map(line => ({ ...line, netMinor: 0, taxMinor: 1 })), linesMoneyMinor: 2,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 2 }) }))
      .toEqual({ ok: true, totalMinor: 2, lines: [
        { ...take('ordli_a')[0], netMinor: 0, taxMinor: 1 }, { ...take('ordli_b')[0], netMinor: 0, taxMinor: 1 },
        { ...take('ordli_c')[0], netMinor: 0, taxMinor: 0 },
      ] })
  })

  it('N1-largest-gross: the later of the largest gross lines takes the negative difference on tax', () => {
    expect(priceRefund({ ...order, lines: lines.map((line, index) => ({ ...line, netMinor: 0, taxMinor: index === 1 ? 1 : 2 })),
      linesMoneyMinor: 4, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 4 }) }))
      .toEqual({ ok: true, totalMinor: 4, lines: [
        { ...take('ordli_a')[0], netMinor: 0, taxMinor: 2 }, { ...take('ordli_b')[0], netMinor: 0, taxMinor: 1 },
        { ...take('ordli_c')[0], netMinor: 0, taxMinor: 1 },
      ] })
  })

  it('N1-948-free-line: three single refunds take 354 within the payment cap; the free last line is nothing_to_refund', () => {
    const shipped = { ...order, lines: [...lines, { id: 'ordli_z', quantity: 1, returnedQuantity: 0, netMinor: 0, taxMinor: 0 }], shippingMinor: 595 }
    const earlier: PriceRefundInput['earlier'] = []
    const totals: number[] = []
    for (const id of ['ordli_a', 'ordli_b', 'ordli_c']) {
      const result = priceRefund({ ...shipped, earlier, refundableMoneyMinor: 948 - totals.reduce((sum, total) => sum + total, 0),
        request: request({ lines: take(id), totalMinor: 118 }) })
      expect(result).toEqual({ ok: true, totalMinor: 118, lines: [{ ...take(id)[0], netMinor: 99, taxMinor: 19 }] })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      earlier.push({ lines: result.lines, shippingMinor: 0, medusaRefundId: 'refund_1' })
      totals.push(result.totalMinor)
    }
    const total = totals.reduce((sum, amount) => sum + amount, 0)
    expect(total).toBe(354)
    expect(total).toBeLessThanOrEqual(948)
    expect(priceRefund({ ...shipped, earlier, refundableMoneyMinor: 948 - total,
      request: request({ lines: take('ordli_z'), totalMinor: 0 }) }))
      .toMatchObject({ ok: false, error: { code: 'nothing_to_refund' } })
  })

  it('N1-dropped: a difference within the bound that neither net nor target tax covers is dropped', () => {
    expect(priceRefund({ ...order, lines: lines.map(line => ({ ...line, netMinor: 1, taxMinor: 0 })), linesMoneyMinor: 1,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 3 }) }))
      .toEqual({ ok: true, totalMinor: 3, lines: [
        { ...take('ordli_a')[0], netMinor: 1, taxMinor: 0 }, { ...take('ordli_b')[0], netMinor: 1, taxMinor: 0 },
        { ...take('ordli_c')[0], netMinor: 1, taxMinor: 0 },
      ] })
  })

  it('N1-dropped-cap: four 0.006 lines drop -2 (4 against a cap of 2); the total is refused, never above the money left', () => {
    const tiny = ['ordli_a', 'ordli_b', 'ordli_c', 'ordli_d'].map(id => ({ id, quantity: 1, returnedQuantity: 0, ...connectorSplit('0.006', '0.00096', 2) }))
    expect(tiny[0]).toMatchObject({ netMinor: 1, taxMinor: 0 })
    const money = refundMoneyMinor(2, '0.024', [], [])
    expect(money).toEqual({ linesMoneyMinor: 2, shippingMinor: 0 })
    const price = (totalMinor: number) => priceRefund({ ...order, lines: tiny, ...money, paidMinor: 2, refundableMoneyMinor: 2,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c', 'ordli_d'), totalMinor }) })
    // The dropped difference prices the lines at 4; the cap refuses 4, and the cap's 2 is not the price (#547).
    expect(price(4)).toMatchObject({ ok: false, error: { code: 'amount_mismatch', data: { expectedMinor: 4, serverMinor: 2 } } })
    expect(price(2)).toMatchObject({ ok: false, error: { code: 'amount_mismatch', data: { expectedMinor: 2, serverMinor: 4 } } })
    for (let totalMinor = 0; totalMinor <= 6; totalMinor++) expect(price(totalMinor)).toMatchObject({ ok: false })
  })

  it('a full refund that also takes the shipping prices the lines at the money left less the shipping left', () => {
    const shipped = { ...order, shippingMinor: 500, refundableMoneyMinor: 853 }
    expect(priceRefund({ ...shipped, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), shippingMinor: 500, totalMinor: 853 }) }))
      .toMatchObject({ ok: true, totalMinor: 853 })
    // Shipping kept for a later refund: the lines take 853 less the 500 still unrefunded.
    expect(priceRefund({ ...shipped, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 353 }) }))
      .toMatchObject({ ok: true, totalMinor: 353 })
  })
})

// ADR 0026 decision 5 (2026-11-24): the till sees each shipping method's and fee's own rounded gross, so the store rounds
// them per item. Every case has one product line at 10.00 ex 19% (gross 11.90, tax 1.90: net 1000, tax 190).
describe('refundMoneyMinor rounds shipping and fees per item', () => {
  const lines = [{ id: 'ordli_1', quantity: 1, returnedQuantity: 0, ...connectorSplit('11.9', '1.9', 2) }]
  const fullRefund = (money: { linesMoneyMinor: number | null; shippingMinor: number }, paymentMinor: number, totalMinor: number) =>
    priceRefund({ lines, ...money, earlier: [], paidMinor: paymentMinor, outsideRefundsMinor: 0, refundableMoneyMinor: paymentMinor,
      request: request({ lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true }], shippingMinor: money.shippingMinor, totalMinor }) })
  // [name, payment, shipping raws, fee raws, linesMoney, shipping, the till's full-refund total (payment less fees)]
  const cases: [string, string, string[], string[], number, number, number][] = [
    ['one 4.50 ex 19% shipping (5.355), paid 17.26: lines 1726 − 536', '17.26', ['5.355'], [], 1190, 536, 1726],
    ['two 1.02 ex 19% shippings (1.2138 each), paid 14.33: lines 1433 − 121 − 121', '14.33', ['1.2138', '1.2138'], [], 1191, 242, 1433],
    ['a 1.02 ex 19% shipping and a 1.02 ex 19% fee, paid 14.33: lines 1433 − 121 − 121', '14.33', ['1.2138'], ['1.2138'], 1191, 121, 1312],
    ['a 4.50 ex 19% fee (5.355), paid 17.26: lines 1726 − 536', '17.26', [], ['5.355'], 1190, 0, 1190],
    ['whole-cent raws are unchanged: two 2.50 shippings and a 1.19 fee, paid 18.09', '18.09', ['2.5', '2.5'], ['1.19'], 1190, 500, 1690],
  ]

  it.each(cases)('%s', (_name, payment, shipping, fees, linesMoneyMinor, shippingMinor, totalMinor) => {
    const money = refundMoneyMinor(2, payment, shipping, fees)
    expect(money).toEqual({ linesMoneyMinor, shippingMinor })
    // The till's full refund: every line at full quantity, all the shipping, adjustment 0; fees stay with the store.
    expect(totalMinor).toBe(medusaSumMinor(2, [payment]) - fees.reduce((sum, fee) => sum + medusaSumMinor(2, [fee]), 0))
    expect(fullRefund(money, medusaSumMinor(2, [payment]), totalMinor)).toMatchObject({ ok: true, totalMinor })
  })

  it("the 17.26 sale's full refund was refused under one rounding over the raw sum (1191 + 536 = 1727 > 1726 paid)", () => {
    const oneRounding = { linesMoneyMinor: 1191, shippingMinor: 536 }
    expect(fullRefund(oneRounding, 1726, 1726)).toMatchObject({ ok: false, error: { code: 'amount_mismatch', data: { serverMinor: 1727 } } })
    expect(fullRefund(oneRounding, 1726, 1727)).toMatchObject({ ok: false, error: { code: 'amount_mismatch', data: { serverMinor: 1726 } } })
  })

  it('an order with no payment has no line money', () => {
    expect(refundMoneyMinor(2, null, ['5.355'], ['1.19'])).toEqual({ linesMoneyMinor: null, shippingMinor: 536 })
  })
})

// #547 (desk 2026-11-24): the 3.53 sale (3 × 0.99 ex 19%) after earlier goodwill no row puts on a line is refunded at what
// is left. The goodwill row is recorded (medusaRefundId set), so the cap C is the payment less the goodwill.
describe('the goodwill clamp (#547)', () => {
  const lines = ['ordli_a', 'ordli_b', 'ordli_c'].map(id => ({ id, quantity: 1, returnedQuantity: 0, ...connectorSplit('1.1781', '0.1881', 2) }))
  const all = lines.map(({ id }) => ({ orderLineId: id, quantity: 1, restock: true }))
  const goodwillRow = (medusaRefundId: string | null = 'refund_g') => ({ lines: [], shippingMinor: 0, medusaRefundId })
  const sale = (goodwillMinor: number, extra: Partial<PriceRefundInput> = {}): Omit<PriceRefundInput, 'request'> => ({ lines,
    linesMoneyMinor: 353, shippingMinor: 0, paidMinor: 353, earlier: [goodwillRow()], outsideRefundsMinor: 0, refundableMoneyMinor: 353 - goodwillMinor, ...extra })
  const priced = (net: number[], tax = [19, 19, 19]) => all.map((entry, n) => ({ ...entry, netMinor: net[n], taxMinor: tax[n] }))
  const refused = (message: string, expectedMinor: number, serverMinor: number) => ({ ok: false, error: { code: 'amount_mismatch', message, data: { expectedMinor, serverMinor } } })
  const cap = 'The refund is more than the money the order has left to refund.'
  const differs = "The refund total differs from the store's."
  const outside = (outsideMinor: number) => ({ ok: false, error: { code: 'order_state', data: { reason: 'refunded_outside_till', outsideMinor },
    message: 'This order has a refund made outside the till (Medusa shows more refunded than the till recorded). Finish it in Medusa Admin.' } })
  // The order with 5.95 gross shipping, paid 9.48, and 0.01 goodwill refunded.
  const shipped = (earlier = [goodwillRow()], refundableMoneyMinor = 947) => sale(1, { shippingMinor: 595, paidMinor: 948, earlier, refundableMoneyMinor })

  it('clamp: till goodwill 1', () => {
    // N1 puts 353 on the lines (the last 0.99 net is 0.98); the clamp takes O = 1 off the later 118 line's net.
    expect(priceRefund({ ...sale(1), request: request({ lines: all, totalMinor: 352 }) })).toEqual({ ok: true, totalMinor: 352, lines: priced([99, 98, 98]) })
  })

  it('clamp: O equals G', () => {
    // O = 5 of 353: floors 1, 1, 1 (remainders 237, 237, 232); the 2 units left go to the two 118 lines.
    expect(priceRefund({ ...sale(5), request: request({ lines: all, totalMinor: 348 }) })).toEqual({ ok: true, totalMinor: 348, lines: priced([97, 97, 97]) })
  })

  it('clamp: O above G refuses', () => {
    // A full-lines overrun beyond the goodwill needs an N1 difference that was dropped: three 0.01 lines priced at 3 on a
    // payment of 2 (1 shipping), 1 goodwill. O = 3 − 1 = 2, G = 2 − 1 = 1.
    const tiny = lines.map(entry => ({ ...entry, netMinor: 1, taxMinor: 0 }))
    expect(priceRefund({ ...sale(1, { lines: tiny, linesMoneyMinor: 1, shippingMinor: 1, paidMinor: 2, refundableMoneyMinor: 1 }),
      request: request({ lines: all, totalMinor: 3 }) })).toEqual(refused(cap, 3, 1))
  })

  it('clamp: shipping kept, lines take O', () => {
    expect(priceRefund({ ...shipped(), request: request({ lines: all, shippingMinor: 595, totalMinor: 947 }) })).toEqual({ ok: true, totalMinor: 947, lines: priced([99, 98, 98]) })
    expect(priceRefund({ ...shipped(), request: request({ lines: all, shippingMinor: 595, totalMinor: 948 }) })).toEqual(refused(differs, 948, 947))
  })

  it('item 2: shipping after goodwill', () => {
    expect(priceRefund({ ...shipped(), request: request({ shippingMinor: 595, totalMinor: 595 }) })).toEqual({ ok: true, totalMinor: 595, lines: [] })
    expect(priceRefund({ ...shipped(), request: request({ shippingMinor: 596, totalMinor: 596 }) })).toEqual(refused('The shipping refunded is more than the order has left to refund.', 596, 595))
  })

  it('item 2: lines after goodwill and shipping', () => {
    const earlier = [goodwillRow(), { lines: [], shippingMinor: 595, medusaRefundId: 'refund_s' }]
    expect(priceRefund({ ...shipped(earlier, 352), request: request({ lines: all, totalMinor: 352 }) })).toEqual({ ok: true, totalMinor: 352, lines: priced([99, 98, 98]) })
  })

  it('clamp: unrecorded row blocks the clamp', () => {
    // A goodwill row with no Medusa refund recorded is held back twice (N3): C = 353 − 1 − 1 = 351, G = 2 is not goodwill.
    const unrecorded = sale(2, { earlier: [goodwillRow(null)] })
    expect(priceRefund({ ...unrecorded, request: request({ lines: all, totalMinor: 351 }) })).toEqual(refused(differs, 351, 353))
    expect(priceRefund({ ...unrecorded, request: request({ lines: all, totalMinor: 353 }) })).toEqual(refused(cap, 353, 351))
  })

  it('clamp: no lines, no clamp', () => {
    expect(priceRefund({ ...sale(5), request: request({ adjustmentMinor: 350, totalMinor: 350 }) })).toEqual(refused(cap, 350, 348))
  })

  it('clamp: a Medusa return beyond the rows blocks it', () => {
    const returnedLines = lines.map((entry, n) => ({ ...entry, returnedQuantity: n === 0 ? 1 : 0 }))
    const returned = sale(1, { lines: returnedLines })
    // #565: the Medusa return takes line a out of a Refund all before the clamp is reached.
    expect(priceRefund({ ...returned, request: request({ lines: all, totalMinor: 352 }) })).toEqual({ ok: false, error: { code: 'quantity_exceeds',
      message: 'A line asks for more than its refundable quantity, or is not on the order.',
      data: { lines: [{ orderLineId: 'ordli_a', quantity: 1, refundableQuantity: 0 }] } } })
    // The unit twin of the integration test: 1.18 refunded with the Admin return looks like goodwill to the clamp (G = 353 − 235),
    // and the two lines left price at 236 on a cap of 235. Line a's returned quantity keeps the clamp off.
    const admin = sale(118, { lines: returnedLines })
    const rest = all.slice(1)
    expect(priceRefund({ ...admin, request: request({ lines: rest, totalMinor: 236 }) })).toEqual(refused(cap, 236, 235))
    expect(priceRefund({ ...admin, request: request({ lines: rest, totalMinor: 235 }) })).toEqual(refused(differs, 235, 236))
  })

  it('clamp: one figure, no ping-pong', () => {
    expect(priceRefund({ ...sale(1), request: request({ lines: all, totalMinor: 353 }) })).toEqual(refused(differs, 353, 352))
    expect(priceRefund({ ...sale(1), request: request({ lines: all, totalMinor: 352 }) })).toMatchObject({ ok: true, totalMinor: 352 })
  })

  it('clamp: proportional split', () => {
    // 1.50 goodwill: 50 off each line by gross (118, 118, 117 of 353), then 8 tax and 42 net within each.
    const result = priceRefund({ ...sale(150), request: request({ lines: all, totalMinor: 203 }) })
    expect(result).toEqual({ ok: true, totalMinor: 203, lines: priced([57, 57, 56], [11, 11, 11]) })
    expect(result.ok && result.lines.reduce((sum, entry) => sum + entry.netMinor + entry.taxMinor, 0)).toBe(203)
    expect(result.ok && result.lines.every(entry => entry.netMinor >= 0 && entry.taxMinor >= 0)).toBe(true)
  })

  // n one-unit lines at 1.00 (net 84, tax 16), paid n × 100, with g goodwill refunded earlier.
  const even = (n: number, goodwill: number) => {
    const ids = Array.from({ length: n }, (_, index) => `ordli_${index}`)
    const order = { lines: ids.map(id => ({ id, quantity: 1, returnedQuantity: 0, netMinor: 84, taxMinor: 16 })), linesMoneyMinor: n * 100,
      shippingMinor: 0, paidMinor: n * 100, earlier: [goodwillRow()], outsideRefundsMinor: 0, refundableMoneyMinor: n * 100 - goodwill }
    return { order, take: ids.map(orderLineId => ({ orderLineId, quantity: 1, restock: true })) }
  }

  it('R2-split-4: the parts never overshoot O; the later lines win the ties', () => {
    // O = 2 of 400: every floor is 0 with remainder 200, so the 2 units go to the two later lines, 1 each, off the net.
    const { order, take } = even(4, 2)
    expect(priceRefund({ ...order, request: request({ lines: take, totalMinor: 398 }) })).toEqual({ ok: true, totalMinor: 398,
      lines: take.map((entry, n) => ({ ...entry, netMinor: [84, 84, 83, 83][n], taxMinor: 16 })) })
    expect(priceRefund({ ...order, request: request({ lines: take, totalMinor: 400 }) })).toEqual(refused(differs, 400, 398))
  })

  it('R2-split-sweep: n equal lines with goodwill 1..n are all accepted at what is left', () => {
    const failures: string[] = []
    for (let n = 2; n <= 8; n++) for (let goodwill = 1; goodwill <= n; goodwill++) {
      const { order, take } = even(n, goodwill)
      const totalMinor = n * 100 - goodwill
      const result = priceRefund({ ...order, request: request({ lines: take, totalMinor }) })
      const sum = result.ok ? result.lines.reduce((total, entry) => total + entry.netMinor + entry.taxMinor, 0) : NaN
      if (!result.ok || result.totalMinor !== totalMinor || sum !== totalMinor || result.lines.some(entry => entry.netMinor < 0 || entry.taxMinor < 0)) {
        failures.push(`n=${n} goodwill=${goodwill} total=${totalMinor}: ${JSON.stringify(result.ok ? { sum, lines: result.lines } : result.error)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it("R2-fee: the app's 472 case: the kept 1.19 fee leaves the cap above the lines, so 353 passes with no clamp", () => {
    // Paid 4.72 = lines 3.53 + a 1.19 fee the store keeps; 0.01 goodwill refunded at a till (a row), or in Medusa Admin (no
    // row, not baselined), which is refused up front.
    const money = refundMoneyMinor(2, '4.72', [], ['1.19'])
    expect(money).toEqual({ linesMoneyMinor: 353, shippingMinor: 0 })
    const order = { lines, ...money, paidMinor: 472, earlier: [goodwillRow()], outsideRefundsMinor: 0, refundableMoneyMinor: 471 }
    expect(priceRefund({ ...order, request: request({ lines: all, totalMinor: 353 }) })).toEqual({ ok: true, totalMinor: 353, lines: priced([99, 99, 98]) })
    expect(priceRefund({ ...order, request: request({ lines: all, totalMinor: 352 }) })).toEqual(refused(differs, 352, 353))
    expect(priceRefund({ ...order, earlier: [], outsideRefundsMinor: 1, request: request({ lines: all, totalMinor: 353 }) })).toEqual(outside(1))
  })

  it('R3-unit: a refund made outside the till is refused before any other check; with none the clamp is unchanged', () => {
    expect(priceRefund({ ...sale(1, { outsideRefundsMinor: 1 }), request: request({ lines: all, totalMinor: 352 }) })).toEqual(outside(1))
    // Refused first: even a request that would otherwise be nothing_to_refund or quantity_exceeds.
    expect(priceRefund({ ...sale(1, { outsideRefundsMinor: 1 }), request: request({}) })).toEqual(outside(1))
    expect(priceRefund({ ...sale(1, { outsideRefundsMinor: 1 }), request: request({ lines: [{ orderLineId: 'ordli_x', quantity: 1, restock: true }], totalMinor: 1 }) })).toEqual(outside(1))
    expect(priceRefund({ ...sale(1, { outsideRefundsMinor: 0 }), request: request({ lines: all, totalMinor: 352 }) })).toEqual({ ok: true, totalMinor: 352, lines: priced([99, 98, 98]) })
  })
})

describe("the refundable quantity counts Medusa's returns (#565)", () => {
  const exceeds = (quantity: number, refundableQuantity: number) => ({ ok: false, error: { code: 'quantity_exceeds',
    message: 'A line asks for more than its refundable quantity, or is not on the order.', data: { lines: [{ orderLineId: 'ordli_1', quantity, refundableQuantity }] } } })
  const take = (quantity: number) => [{ orderLineId: 'ordli_1', quantity, restock: true }]
  // The till refunded one unit of three (its own return, so Medusa's returnedQuantity is at least 1).
  const tillOne = { ...base, refundableMoneyMinor: 1294,
    earlier: [{ lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true, netMinor: 333, taxMinor: 63 }], shippingMinor: 0, medusaRefundId: 'refund_1' }] }

  it('U-565-1: a quantity-1 line Medusa returned with no till refund has nothing refundable', () => {
    const one = { ...base, lines: [{ ...line, quantity: 1, returnedQuantity: 1 }] }
    expect(priceRefund({ ...one, request: request({ lines: take(1), totalMinor: 1190 }) })).toEqual(exceeds(1, 0))
  })

  it("U-565-2: the till's own return is inside Medusa's figure: max, not sum", () => {
    // already = max(1, 1) = 1, so two units are left; a sum (2) would leave one.
    expect(priceRefund({ ...tillOne, lines: [{ ...line, returnedQuantity: 1 }], request: request({ lines: take(2), totalMinor: 794 }) }))
      .toEqual({ ok: true, totalMinor: 794, lines: [{ orderLineId: 'ordli_1', quantity: 2, restock: true, netMinor: 667, taxMinor: 127 }] })
  })

  it('U-565-3: an Admin return beyond the till refund leaves one unit, priced as the third', () => {
    const lines = [{ ...line, returnedQuantity: 2 }]
    expect(priceRefund({ ...tillOne, lines, request: request({ lines: take(2), totalMinor: 794 }) })).toEqual(exceeds(2, 1))
    // already = 2: units 3..3 are 1000 − 667 and 190 − 127 (the till figure alone would price units 2..2 at 334 + 64).
    expect(priceRefund({ ...tillOne, lines, request: request({ lines: take(1), totalMinor: 396 }) }))
      .toEqual({ ok: true, totalMinor: 396, lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true, netMinor: 333, taxMinor: 63 }] })
  })

  it('U-565-4: a returned quantity above the line quantity never makes the refundable quantity negative', () => {
    expect(priceRefund({ ...base, lines: [{ ...line, returnedQuantity: 5 }], request: request({ lines: take(1), totalMinor: 396 }) })).toEqual(exceeds(1, 0))
  })
})
