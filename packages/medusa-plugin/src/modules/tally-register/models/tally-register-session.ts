import { model } from '@medusajs/framework/utils'

export const TallyRegisterSession = model.define('tally_register_session', {
  id: model.text().primaryKey(),
  register_id: model.text(),
  store_key: model.text().nullable(),
  status: model.enum(['open', 'counting', 'closed', 'superseded']),
  device_id: model.text().nullable(),
  device_name: model.text().nullable(),
  superseded_at: model.text().nullable(),
  superseded_by: model.text().nullable(),
  superseded_by_device: model.text().nullable(),
  superseded_by_session: model.text().nullable(),
  business_day: model.text().nullable(),
  // The contract of the open that created the session; null before 0.2.2, read as 1.
  open_contract: model.number().nullable(),
  opened_at: model.text(),
  opened_by: model.text().nullable(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  expected_float_minor: model.number().nullable(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  counted_float_minor: model.number(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  opening_variance_minor: model.number().nullable(),
  status_at: model.text().nullable(),
  closed_at: model.text().nullable(),
  closed_by: model.text().nullable(),
  approved_by: model.text().nullable(),
  counted: model.json().nullable(),
}).indexes([
  { name: 'IDX_tally_register_session_deleted_at', on: ['deleted_at'], where: 'deleted_at is null' },
  { name: 'IDX_tally_register_session_active', on: ['register_id'], unique: true,
    where: "status in ('open','counting') and deleted_at is null" },
])
