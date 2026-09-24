import { model } from '@medusajs/framework/utils'

export const TallyCommand = model.define('tally_command', {
  id: model.text().primaryKey(),
  type: model.text(),
  fingerprint: model.text(),
  claim_token: model.text(),
  status: model.enum(['in_progress', 'applied', 'rejected']).default('in_progress'),
  result: model.json().nullable(),
  stock_topups_applied: model.json().nullable(),
  stock_topups_pending: model.json().nullable(),
})
