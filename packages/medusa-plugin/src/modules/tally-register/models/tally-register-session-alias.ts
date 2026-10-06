import { model } from '@medusajs/framework/utils'

export const TallyRegisterSessionAlias = model.define('tally_register_session_alias', {
  id: model.text().primaryKey(),
  session_id: model.text(),
}).indexes([
  { name: 'IDX_tally_register_session_alias_deleted_at', on: ['deleted_at'], where: 'deleted_at is null' },
  { name: 'IDX_tally_register_session_alias_session', on: ['session_id'], where: null },
])
