import { model } from '@medusajs/framework/utils'

export const TallyRegisterApproval = model.define('tally_register_approval', {
  id: model.text().primaryKey(),
  token_hash: model.text().nullable(),
  session_id: model.text(),
  variance: model.json(),
  approved_by: model.text().nullable(),
  approved_by_name: model.text().nullable(),
  requested_by: model.text(),
  target_email: model.text(),
  expires_at: model.dateTime().nullable(),
  used_at: model.dateTime().nullable(),
  used_by_command_id: model.text().nullable(),
  closure_id: model.text().nullable(),
}).indexes([
  { name: 'IDX_tally_register_approval_token', on: ['token_hash'], unique: true, where: 'token_hash is not null' },
  { name: 'IDX_tally_register_approval_actor', on: ['requested_by', 'created_at'], where: null },
  { name: 'IDX_tally_register_approval_email', on: ['target_email', 'created_at'], where: null },
  { name: 'IDX_tally_register_approval_deleted_at', on: ['deleted_at'], where: 'deleted_at is null' },
])
