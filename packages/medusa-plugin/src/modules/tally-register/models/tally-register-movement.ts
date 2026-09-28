import { model } from '@medusajs/framework/utils'

export const TallyRegisterMovement = model.define('tally_register_movement', {
  id: model.text().primaryKey(),
  session_id: model.text(),
  type: model.enum(['paid_in', 'paid_out', 'no_sale', 'void']),
  amount_minor: model.number(),
  reason: model.text().nullable(),
  created_at_client: model.text(),
  created_by: model.text().nullable(),
  voids: model.text().nullable(),
  voided_by: model.text().nullable(),
}).indexes([{ name: 'IDX_tally_register_movement_session', on: ['session_id'] }])
