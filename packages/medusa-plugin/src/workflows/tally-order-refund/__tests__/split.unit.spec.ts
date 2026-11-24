import { splitRefund } from '../split'

const cardAndCash = [{ id: 'pay-card', method: 'card', amountMinor: 3000 }, { method: 'cash', amountMinor: 2000 }]

describe('splitRefund (ADR 0026 decision 4)', () => {
  it('S1: card 3000 + cash 2000 refunded in full to the original methods', () => {
    expect(splitRefund({ orderId: 'order_1', tenders: cardAndCash, earlier: [], totalMinor: 5000, destination: 'original_method' })).toEqual({
      refunds: [{ paymentId: 'pay-card', method: 'card', totalMinor: 3000 }, { paymentId: 'order_1:1', method: 'cash', totalMinor: 2000 }],
      byMethod: { card: 3000, cash: 2000 },
    })
  })

  it('takes non-cash tenders first in the order taken, then cash', () => {
    const tenders = [{ method: 'cash', amountMinor: 1000 }, { id: 'a', method: 'card', amountMinor: 500 }, { id: 'b', method: 'external', amountMinor: 700 }]
    expect(splitRefund({ orderId: 'o', tenders, earlier: [], totalMinor: 1500, destination: 'original_method' })).toEqual({
      refunds: [{ paymentId: 'a', method: 'card', totalMinor: 500 }, { paymentId: 'b', method: 'external', totalMinor: 700 },
        { paymentId: 'o:0', method: 'cash', totalMinor: 300 }],
      byMethod: { card: 500, external: 700, cash: 300 },
    })
  })

  it('S2: a cash tender that gave change refunds at most its amountMinor', () => {
    const tenders = [{ id: 'c', method: 'cash', amountMinor: 2000, tenderedMinor: 5000, changeMinor: 3000 }]
    const split = splitRefund({ orderId: 'o', tenders, earlier: [], totalMinor: 2000, destination: 'original_method' })
    expect(split).toEqual({ refunds: [{ paymentId: 'c', method: 'cash', totalMinor: 2000 }], byMethod: { cash: 2000 } })
  })

  it('S3: after a full refund no tender has anything left', () => {
    const first = splitRefund({ orderId: 'order_1', tenders: cardAndCash, earlier: [], totalMinor: 5000, destination: 'original_method' })
    const second = splitRefund({ orderId: 'order_1', tenders: cardAndCash, earlier: first.refunds, totalMinor: 100, destination: 'original_method' })
    expect(second.refunds.filter(entry => entry.paymentId === 'pay-card' || entry.paymentId === 'order_1:1')).toEqual([])
    expect(splitRefund({ orderId: 'order_1', tenders: cardAndCash, earlier: first.refunds, totalMinor: 0, destination: 'original_method' }))
      .toEqual({ refunds: [], byMethod: {} })
  })

  it('S4: destination cash puts the whole total on cash for a card sale', () => {
    expect(splitRefund({ orderId: 'o', tenders: [{ id: 'card', method: 'card', amountMinor: 4000 }], earlier: [], totalMinor: 4000, destination: 'cash' }))
      .toEqual({ refunds: [{ paymentId: 'o:cash', method: 'cash', totalMinor: 4000 }], byMethod: { cash: 4000 } })
  })

  it('a card sale refunded to the original method with nothing left on the card falls back to a cash entry', () => {
    const tenders = [{ id: 'card', method: 'card', amountMinor: 1000 }]
    expect(splitRefund({ orderId: 'o', tenders, earlier: [{ paymentId: 'card', method: 'card', totalMinor: 800 }], totalMinor: 500,
      destination: 'original_method' })).toEqual({ refunds: [{ paymentId: 'card', method: 'card', totalMinor: 200 },
      { paymentId: 'o:cash', method: 'cash', totalMinor: 300 }], byMethod: { card: 200, cash: 300 } })
  })
})
