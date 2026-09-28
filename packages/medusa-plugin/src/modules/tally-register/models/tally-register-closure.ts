import { model } from '@medusajs/framework/utils'

export const TallyRegisterClosure = model.define('tally_register_closure', {
  id: model.text().primaryKey(),
  session_id: model.text(),
  register_id: model.text(),
  number: model.number(),
  business_day: model.text().nullable(),
  opened_at: model.text(),
  closed_at: model.text(),
  closed_by: model.text().nullable(),
  approved_by: model.text().nullable(),
  till_expected: model.json(),
  counted: model.json(),
  expected: model.json().nullable(),
  variance: model.json().nullable(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  period_sales_total_minor: model.number(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  period_refunds_total_minor: model.number(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  perpetual_sales_total_minor: model.number(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  perpetual_refunds_total_minor: model.number(),
  unsynced_count: model.number(),
  // The migration uses bigint for this integer; results use JSON numeric values.
  unsynced_total_minor: model.number(),
  software_version: model.text(),
  order_ids: model.json(),
  movement_ids: model.json(),
}).indexes([
  { name: 'IDX_tally_register_closure_session', on: ['session_id'], unique: true },
  { name: 'IDX_tally_register_closure_number', on: ['register_id', 'number'], unique: true },
])
