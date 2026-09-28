import { model } from '@medusajs/framework/utils'

export const TallyRegisterSession = model.define('tally_register_session', {
  id: model.text().primaryKey(),
  register_id: model.text(),
  store_key: model.text().nullable(),
  status: model.enum(['open', 'counting', 'closed']),
  business_day: model.text().nullable(),
  opened_at: model.text(),
  opened_by: model.text().nullable(),
  expected_float_minor: model.number().nullable(),
  counted_float_minor: model.number(),
  opening_variance_minor: model.number().nullable(),
  status_at: model.text().nullable(),
  closed_at: model.text().nullable(),
  closed_by: model.text().nullable(),
  approved_by: model.text().nullable(),
  counted: model.json().nullable(),
}).indexes([
  { name: 'IDX_tally_register_session_active', on: ['register_id'], unique: true,
    where: "status <> 'closed' and deleted_at is null" },
])
