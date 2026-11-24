import { refundPayloadErrors } from '../payload-shape'

const valid = {
  clientRefundId: 'refund-1', orderId: 'order_1', registerId: 'r', sessionId: 's', clientOrderId: 'c', cashierRef: 'u',
  lines: [{ orderLineId: 'ordli_1', quantity: 1, restock: true }], shippingMinor: 0, adjustmentMinor: 0, totalMinor: 100,
  destination: 'original_method', reason: 'Wrong size', createdAt: '2026-11-22T10:00:00.000Z',
}

describe('order.refund v1 payload shape (core 4.1.0 refundPayloadErrors)', () => {
  it('accepts a valid payload, with or without the optional ids, and a cash destination', () => {
    expect(refundPayloadErrors(valid)).toEqual([])
    const { clientOrderId: _c, cashierRef: _u, ...bare } = valid
    expect(refundPayloadErrors({ ...bare, lines: [], destination: 'cash', adjustmentMinor: -5 })).toEqual([])
  })

  it('refuses a non-object', () => {
    for (const payload of [null, [], 'x', 1, new Date()]) expect(refundPayloadErrors(payload)).toEqual(['payload: expected an object'])
  })

  it('names unknown fields, quoting a key with NUL', () => {
    expect(refundPayloadErrors({ ...valid, extra: 1, 'a\0b': 1 })).toEqual([
      'extra: unknown field for order.refund version 1', '"a\\u0000b": unknown field for order.refund version 1',
    ])
  })

  it('checks the id strings and NUL', () => {
    expect(refundPayloadErrors({ ...valid, clientRefundId: '', orderId: 'o'.repeat(65), registerId: 1, cashierRef: null,
      sessionId: 's\0' })).toEqual([
      'clientRefundId: expected a non-empty string of at most 64 characters',
      'orderId: expected a non-empty string of at most 64 characters',
      'registerId: expected a non-empty string of at most 64 characters',
      'sessionId: expected no NUL character',
      'cashierRef: expected a non-empty string of at most 64 characters',
    ])
  })

  it('checks lines', () => {
    expect(refundPayloadErrors({ ...valid, lines: {} })).toEqual(['lines: expected an array of at most 500 lines'])
    expect(refundPayloadErrors({ ...valid, lines: Array.from({ length: 501 }, (_, i) => ({ orderLineId: `l${i}`, quantity: 1, restock: true })) }))
      .toEqual(['lines: expected an array of at most 500 lines'])
    expect(refundPayloadErrors({ ...valid, lines: [
      null, { orderLineId: 'a', quantity: 0, restock: 'yes', note: 1 }, { orderLineId: 'a', quantity: 1.5, restock: false },
      { orderLineId: '', quantity: 1, restock: true },
    ] })).toEqual([
      'lines[0]: expected an object',
      'lines[1].note: unknown field for order.refund version 1',
      'lines[1].quantity: expected a safe integer >= 1',
      'lines[1].restock: expected a boolean',
      'lines[2].orderLineId: expected unique in lines',
      'lines[2].quantity: expected a safe integer >= 1',
      'lines[3].orderLineId: expected a non-empty string of at most 64 characters',
    ])
  })

  it('checks the money, destination, reason and date', () => {
    expect(refundPayloadErrors({ ...valid, shippingMinor: -1, totalMinor: 1.5, adjustmentMinor: '1', destination: 'card',
      reason: '   ', createdAt: 'yesterday' })).toEqual([
      'shippingMinor: expected a safe integer >= 0',
      'totalMinor: expected a safe integer >= 0',
      'adjustmentMinor: expected a safe integer',
      'destination: expected original_method or cash',
      'reason: expected a non-empty string after trim of at most 500 characters',
      'createdAt: expected a valid date',
    ])
    expect(refundPayloadErrors({ ...valid, reason: 'r'.repeat(501) }))
      .toEqual(['reason: expected a non-empty string after trim of at most 500 characters'])
    expect(refundPayloadErrors({ ...valid, reason: 'a\0' })).toEqual(['reason: expected no NUL character'])
  })

  it('stops at 10 errors', () => {
    const errors = refundPayloadErrors({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11 })
    expect(errors).toHaveLength(10)
    expect(errors[9]).toBe('j: unknown field for order.refund version 1')
  })
})
