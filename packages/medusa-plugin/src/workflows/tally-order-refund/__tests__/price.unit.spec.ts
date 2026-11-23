import { connectorSplit, medusaSumMinor, priceRefund, type PriceRefundInput } from '../price'

const request = (overrides: Partial<PriceRefundInput['request']>): PriceRefundInput['request'] =>
  ({ lines: [], shippingMinor: 0, adjustmentMinor: 0, totalMinor: 0, ...overrides })
const line = { id: 'ordli_1', quantity: 3, netMinor: 1000, taxMinor: 190 }
const base: Omit<PriceRefundInput, 'request'> = { lines: [line], shippingMinor: 500, earlier: [], refundableMoneyMinor: 100_000 }

describe('priceRefund (pos priceRefund on the connector split, ADR 0026 decision 5)', () => {
  it("P1: prices from the connector's round(gross − tax), not round(gross) − round(tax)", () => {
    // gross 10.004, tax 1.665 at 2 decimals: the two rules split the same 1000 differently.
    expect(connectorSplit('10.004', '1.665', 2)).toEqual({ netMinor: 834, taxMinor: 166 })
    const listRule = { netMinor: medusaSumMinor(2, ['10.004']) - medusaSumMinor(2, ['1.665']), taxMinor: medusaSumMinor(2, ['1.665']) }
    expect(listRule).toEqual({ netMinor: 833, taxMinor: 167 })
    const lines = [{ id: 'ordli_1', quantity: 3, ...connectorSplit('10.004', '1.665', 2) }]
    const one = [{ orderLineId: 'ordli_1', quantity: 1, restock: true }]
    // One unit of three: connector 278 + 55 = 333; the list rule would give 278 + 56 = 334.
    expect(priceRefund({ ...base, lines, request: request({ lines: one, totalMinor: 333 }) }))
      .toEqual({ ok: true, totalMinor: 333, lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true, netMinor: 278, taxMinor: 55 }] })
    expect(priceRefund({ ...base, lines, request: request({ lines: one, totalMinor: 334 }) })).toEqual({ ok: false, error: {
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
    for (const totalMinor of [396, 398, 396]) {
      const result = priceRefund({ ...base, earlier, request: request({ lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true }], totalMinor }) })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      taken.push(result.lines[0])
      earlier.push({ lines: [{ orderLineId: 'ordli_1', quantity: 1 }], shippingMinor: 0 })
    }
    expect(taken.map(({ netMinor, taxMinor }) => [netMinor, taxMinor])).toEqual([[333, 63], [334, 64], [333, 63]])
    expect(taken.reduce((sum, row) => sum + row.netMinor, 0)).toBe(1000)
    expect(taken.reduce((sum, row) => sum + row.taxMinor, 0)).toBe(190)
  })

  it('P3: a quantity above the refundable one, or an unknown line, is quantity_exceeds', () => {
    const earlier = [{ lines: [{ orderLineId: 'ordli_1', quantity: 2 }], shippingMinor: 0 }]
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
    for (const input of [{ ...base, request: request({}) }, { ...base, refundableMoneyMinor: null, request: request({ shippingMinor: 1, totalMinor: 1 }) },
      { ...base, request: request({ adjustmentMinor: 0, shippingMinor: 0, lines: [], totalMinor: 0 }) }]) {
      expect(priceRefund(input)).toMatchObject({ ok: false, error: { code: 'nothing_to_refund' } })
    }
  })
})
