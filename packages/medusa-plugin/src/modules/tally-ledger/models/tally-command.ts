import { model } from '@medusajs/framework/utils'

export const TallyCommand = model.define('tally_command', {
  id: model.text().primaryKey(),
  type: model.text(),
  fingerprint: model.text(),
  status: model.enum(['in_progress', 'applied', 'rejected']).default('in_progress'),
  result: model.json().nullable(),
})
