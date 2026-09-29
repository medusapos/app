import { model } from '@medusajs/framework/utils'

export const TallyChange = model.define('tally_change', {
  // DML has no bigserial type; this model registers the table, and all access uses raw SQL.
  seq: model.number().primaryKey(),
  collection: model.text(),
  object_id: model.text(),
  op: model.enum(['upsert', 'delete']),
}).indexes([
  { name: 'IDX_tally_change_object', on: ['collection', 'object_id'], where: null },
])
