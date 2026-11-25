import { model } from '@medusajs/framework/utils'

// A till refund (ADR 0026 decision 3). return_id, received_at and medusa_refund_id are the resume points, written in
// that order; the migration uses bigint for the minor amounts.
export const TallyRefund = model.define('tally_refund', {
  id: model.text().primaryKey(),
  client_refund_id: model.text(),
  command_id: model.text(),
  order_id: model.text(),
  session_id: model.text(),
  status: model.enum(['in_progress', 'applied', 'needs_admin']).default('in_progress'),
  lines: model.json(),
  shipping_minor: model.number(),
  adjustment_minor: model.number(),
  total_minor: model.number(),
  reason: model.text(),
  by_method: model.json(),
  refunds: model.json(),
  return_id: model.text().nullable(),
  received_at: model.dateTime().nullable(),
  medusa_refund_id: model.text().nullable(),
  money_started_at: model.dateTime().nullable(),
}).indexes([
  { name: 'IDX_tally_refund_client_refund_id', on: ['client_refund_id'], unique: true, where: null },
  { name: 'IDX_tally_refund_session_status', on: ['session_id', 'status'], where: null },
  { name: 'IDX_tally_refund_order', on: ['order_id'], where: null },
  { name: 'IDX_tally_refund_deleted_at', on: ['deleted_at'], where: 'deleted_at is null' },
])
