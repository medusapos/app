import { model } from '@medusajs/framework/utils'

export const TallySyncState = model.define('tally_sync_state', {
  id: model.text().primaryKey(),
  epoch: model.text(),
  price_list_watermark: model.dateTime().nullable(),
  price_window_run_at: model.dateTime().nullable(),
})
