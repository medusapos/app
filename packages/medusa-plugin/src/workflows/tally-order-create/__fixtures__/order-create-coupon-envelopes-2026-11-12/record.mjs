// Records the order.create envelope @tallyui/pos 3.19.0 sends for a 1190 tax-inclusive line (19%), a 100 store-priced coupon
// and, unless run with 'nodiscount', a 10% line discount: node record.mjs [nodiscount] > <file>.json
const root = new URL('../../../../../../../apps/expo/node_modules/@tallyui/pos/dist/index.js', import.meta.url).href
const { createOrderBuilder, finalizeOrder, toOrderCreateEnvelope, couponPricingBasis } = await import(root)

const discount = process.argv[2] !== 'nodiscount'
const b = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: true, getTaxRatePpm: () => 190000 } })
const id = b.addLine({ productId: 'p', variantId: 'VARIANT', name: 'Item', unitPrice: { amount: 1190, currency: 'EUR' } })
if (discount) b.applyLineDiscount(id, { type: 'percentage', value: 10 })
b.setCoupons(['c'], { kind: 'store-priced', basis: couponPricingBasis(b.getSnapshot()),
  priced: new Map([['c', { couponId: 'PROMO', lines: [{ lineId: id, amountMinor: 100 }] }]]) })
b.addPayment({ method: 'cash', amountMinor: b.getSnapshot().totalMinor })
console.log(JSON.stringify(toOrderCreateEnvelope(finalizeOrder(b.getSnapshot(), { capabilities: { orderCreate: 7 } }), 'dev'), null, 2))
