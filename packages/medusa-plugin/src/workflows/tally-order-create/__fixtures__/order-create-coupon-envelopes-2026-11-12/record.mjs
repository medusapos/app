// Records @tallyui/pos 3.19.0 envelopes to check till totals: node record.mjs [nodiscount] [nocoupon] [exclusive] > <file>.json
const root = new URL('../../../../../../../apps/expo/node_modules/@tallyui/pos/dist/index.js', import.meta.url).href
const { createOrderBuilder, finalizeOrder, toOrderCreateEnvelope, couponPricingBasis } = await import(root)

const args = process.argv.slice(2)
const discount = !args.includes('nodiscount'), exclusive = args.includes('exclusive')
const b = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: !exclusive, getTaxRatePpm: () => 190000 } })
const id = b.addLine({ productId: 'p', variantId: 'VARIANT', name: 'Item', unitPrice: { amount: exclusive ? 1000 : 1190, currency: 'EUR' } })
if (discount) b.applyLineDiscount(id, { type: 'percentage', value: 10 })
if (!args.includes('nocoupon')) b.setCoupons(['c'], { kind: 'store-priced', basis: couponPricingBasis(b.getSnapshot()),
  priced: new Map([['c', { couponId: 'PROMO', lines: [{ lineId: id, amountMinor: 100 }] }]]) })
b.addPayment({ method: 'cash', amountMinor: b.getSnapshot().totalMinor })
console.log(JSON.stringify(toOrderCreateEnvelope(finalizeOrder(b.getSnapshot(), { capabilities: { orderCreate: 7 } }), 'dev'), null, 2))
