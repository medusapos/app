import { connectorSplit, medusaSumMinor, priceRefund, type PriceRefundInput } from '../price'

const request = (overrides: Partial<PriceRefundInput['request']>): PriceRefundInput['request'] =>
  ({ lines: [], shippingMinor: 0, adjustmentMinor: 0, totalMinor: 0, ...overrides })
const line = { id: 'ordli_1', quantity: 3, netMinor: 1000, taxMinor: 190 }
// The order's payment: the line's 1190 gross and 500 shipping.
const base: Omit<PriceRefundInput, 'request'> = { lines: [line], linesMoneyMinor: 1190, shippingMinor: 500, earlier: [], refundableMoneyMinor: 1690 }

describe('priceRefund (pos priceRefund on the connector split, ADR 0026 decision 5)', () => {
  it("P1: prices from the connector's round(gross − tax), not round(gross) − round(tax)", () => {
    // gross 10.004, tax 1.665 at 2 decimals: the two rules split the same 1000 differently.
    expect(connectorSplit('10.004', '1.665', 2)).toEqual({ netMinor: 834, taxMinor: 166 })
    const listRule = { netMinor: medusaSumMinor(2, ['10.004']) - medusaSumMinor(2, ['1.665']), taxMinor: medusaSumMinor(2, ['1.665']) }
    expect(listRule).toEqual({ netMinor: 833, taxMinor: 167 })
    const lines = [{ id: 'ordli_1', quantity: 3, ...connectorSplit('10.004', '1.665', 2) }]
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
      earlier.push({ lines: result.lines, shippingMinor: 0 })
    }
    expect(taken.map(({ netMinor, taxMinor }) => [netMinor, taxMinor])).toEqual([[333, 63], [334, 64], [333, 63]])
    expect(taken.reduce((sum, row) => sum + row.netMinor, 0)).toBe(1000)
    expect(taken.reduce((sum, row) => sum + row.taxMinor, 0)).toBe(190)
  })

  it('P3: a quantity above the refundable one, or an unknown line, is quantity_exceeds', () => {
    const earlier = [{ lines: [{ orderLineId: 'ordli_1', quantity: 2, restock: true, netMinor: 667, taxMinor: 127 }], shippingMinor: 0 }]
    expect(priceRefund({ ...base, earlier, request: request({ totalMinor: 1, lines: [
      { orderLineId: 'ordli_1', quantity: 2, restock: true }, { orderLineId: 'ordli_x', quantity: 1, restock: false },
    ] }) })).toEqual({ ok: false, error: { code: 'quantity_exceeds',
      message: 'A line asks for more than its refundable quantity, or is not on the order.',
      data: { lines: [{ orderLineId: 'ordli_1', quantity: 2, refundableQuantity: 1 }, { orderLineId: 'ordli_x', quantity: 1, refundableQuantity: 0 }] } } })
  })

  it('refuses shipping above what is left, a total above the money left, and nothing to refund', () => {
    const shippingDone = [{ lines: [], shippingMinor: 300 }]
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
  const lines = ['ordli_a', 'ordli_b', 'ordli_c'].map(id => ({ id, quantity: 1, ...connectorSplit('1.1781', '0.1881', 2) }))
  const order = { lines, linesMoneyMinor: 353, shippingMinor: 0, earlier: [] as PriceRefundInput['earlier'], refundableMoneyMinor: 353 }
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
    const earlier = [{ lines: take('ordli_a', 'ordli_b').map(line => ({ ...line, netMinor: 99, taxMinor: 19 })), shippingMinor: 0 }]
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
    expect(priceRefund({ ...order, refundableMoneyMinor: 472,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 353 }) }))
      .toMatchObject({ ok: true, totalMinor: 353 })
  })

  it('A-goodwill: an earlier adjustment of 1 never enters the lines remainder', () => {
    const earlier = [{ lines: [], shippingMinor: 0, adjustmentMinor: 1, totalMinor: 1 }]
    expect(priceRefund({ ...order, shippingMinor: 500, earlier, refundableMoneyMinor: 852,
      request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 353 }) }))
      .toMatchObject({ ok: true, totalMinor: 353 })
  })

  it('A-withheld: an earlier 118 line with adjustment -3 and total 115 leaves 235 in line money', () => {
    const earlier = [{ lines: [{ ...take('ordli_a')[0], netMinor: 99, taxMinor: 19 }],
      shippingMinor: 0, adjustmentMinor: -3, totalMinor: 115 }]
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
    const shipped = { ...order, lines: [...lines, { id: 'ordli_z', quantity: 1, netMinor: 0, taxMinor: 0 }], shippingMinor: 595 }
    const earlier: PriceRefundInput['earlier'] = []
    const totals: number[] = []
    for (const id of ['ordli_a', 'ordli_b', 'ordli_c']) {
      const result = priceRefund({ ...shipped, earlier, refundableMoneyMinor: 948 - totals.reduce((sum, total) => sum + total, 0),
        request: request({ lines: take(id), totalMinor: 118 }) })
      expect(result).toEqual({ ok: true, totalMinor: 118, lines: [{ ...take(id)[0], netMinor: 99, taxMinor: 19 }] })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      earlier.push({ lines: result.lines, shippingMinor: 0 })
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

  it('a full refund that also takes the shipping prices the lines at the money left less the shipping left', () => {
    const shipped = { ...order, shippingMinor: 500, refundableMoneyMinor: 853 }
    expect(priceRefund({ ...shipped, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), shippingMinor: 500, totalMinor: 853 }) }))
      .toMatchObject({ ok: true, totalMinor: 853 })
    // Shipping kept for a later refund: the lines take 853 less the 500 still unrefunded.
    expect(priceRefund({ ...shipped, request: request({ lines: take('ordli_a', 'ordli_b', 'ordli_c'), totalMinor: 353 }) }))
      .toMatchObject({ ok: true, totalMinor: 353 })
  })
})
