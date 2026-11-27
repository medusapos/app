import type { CampaignBudgetDTO, PromotionDTO, PromotionRuleDTO } from '@medusajs/framework/types'
import { tillCoupons } from '../coupon-list'

const options = { now: Date.parse('2026-11-27T12:00:00Z'), currency: 'EUR', channelId: 'till' }
const method = { id: 'method', target_type: 'items', type: 'percentage', value: 10 } as const
const promotion: PromotionDTO = { id: 'promo', code: 'TEN', is_automatic: false, type: 'standard', status: 'active', application_method: method }
const rule = (operator: PromotionRuleDTO['operator'], value: string, attribute = 'sales_channel_id'): PromotionRuleDTO =>
  ({ id: 'rule', attribute, operator, values: [{ id: 'value', value }] })
const campaign = (type: CampaignBudgetDTO['type'], used = 2, limit = 2) => ({ id: 'campaign', budget: { id: 'budget', type, used, limit } })

it('lists only the six public fields, including the inclusive campaign end', () => {
  const ends_at = new Date(options.now)
  const result = tillCoupons([{ ...promotion, rules: [rule('eq', 'till')], campaign: { id: 'campaign', name: 'Winter', ends_at } }], options)
  expect(result).toEqual({ limit: 100, truncated: false, coupons: [
    { code: 'TEN', label: 'Winter', type: 'percentage', value: 10, currency: null, endsAt: ends_at.toISOString() },
  ] })
})

it.each<[string, Partial<PromotionDTO>]>([
  ['automatic', { is_automatic: true }], ['draft', { status: 'draft' }], ['inactive', { status: 'inactive' }],
  ['not started', { campaign: { id: 'campaign', starts_at: new Date(options.now + 1) } }],
  ['ended', { campaign: { id: 'campaign', ends_at: new Date(options.now - 1) } }],
  ['buyget', { type: 'buyget' }], ['order', { application_method: { ...method, target_type: 'order' } }],
  ['shipping', { application_method: { ...method, target_type: 'shipping_methods' } }],
  ['own limit', { used: 1, limit: 1 }], ['usage exhausted', { campaign: campaign('usage') }],
  ['spend exhausted', { campaign: campaign('spend') }], ['attribute spend', { campaign: campaign('spend_by_attribute', 1.5) }],
  ['unknown budget', { campaign: campaign('future' as CampaignBudgetDTO['type'], 0) }],
  ['another channel', { rules: [rule('in', 'other')] }], ['excluded channel', { rules: [rule('ne', 'till')] }],
  ['unknown channel operator', { rules: [rule('gt', 'other')] }],
  ['other currency', { application_method: { ...method, type: 'fixed', currency_code: 'usd' } }], ['no code', { code: '' }],
])('excludes %s', (_reason, fields) => {
  expect(tillCoupons([{ ...promotion, ...fields }], options).coupons).toEqual([])
})

it.each<[string, Partial<PromotionDTO>]>([
  ['allowed channel', { rules: [rule('in', 'till')] }], ['customer group', { rules: [rule('in', 'members', 'customer.groups.id')] }],
  ['per-customer usage', { campaign: campaign('use_by_attribute') }], ['spend left', { campaign: campaign('spend', 1) }],
])('lists %s without exposing rules or budgets', (_reason, fields) => {
  expect(tillCoupons([{ ...promotion, ...fields }], options).coupons).toEqual([
    { code: 'TEN', label: null, type: 'percentage', value: 10, currency: null, endsAt: null },
  ])
})

it('reports fixed amounts in minor units and lowercase currency, percentages unscaled', () => {
  const fixed: PromotionDTO = { ...promotion, code: 'FIVE', application_method: { ...method, type: 'fixed', value: 5, currency_code: 'EUR' } }
  expect(tillCoupons([promotion, fixed], options).coupons).toMatchObject([
    { code: 'FIVE', value: 500, currency: 'eur' }, { code: 'TEN', value: 10, currency: null },
  ])
})

it.each([100, 101])('sorts before capping %i usable codes', count => {
  const codes = Array.from({ length: count }, (_, index) => `code-${String(index).padStart(3, '0')}`)
  const result = tillCoupons(codes.map(code => ({ ...promotion, code })).reverse(), options)
  expect(result.coupons.map(row => row.code)).toEqual(codes.slice(0, 100))
  expect(result.truncated).toBe(count > 100)
})
