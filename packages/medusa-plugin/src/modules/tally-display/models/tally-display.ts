import { model } from '@medusajs/framework/utils'

// These models register the tables; the service reaches them only with raw SQL, under one advisory lock.

/** A till device; `key_hash` is null only for a pre-migration id, until it adopts. */
export const TallyDisplayDevice = model.define('tally_display_device', {
  id: model.text().primaryKey(),
  key_hash: model.text().nullable(),
  adopted: model.boolean().default(false),
  last_call_at: model.dateTime(),
})

/** A pairing code, keyed by its digits. */
export const TallyDisplayCode = model.define('tally_display_code', {
  id: model.text().primaryKey(),
  device_id: model.text(),
  expires_at: model.dateTime(),
  spent: model.boolean().default(false),
}).indexes([{ name: 'IDX_tally_display_code_device', on: ['device_id'], where: null }])

/** A claim waiting for the minting till's cashier. */
export const TallyDisplayPending = model.define('tally_display_pending', {
  id: model.text().primaryKey(),
  device_id: model.text(),
  secret_hash: model.text(),
  display_name: model.text(),
  check_code: model.text(),
  expires_at: model.dateTime(),
  moving_display_id: model.text().nullable(),
}).indexes([
  { name: 'IDX_tally_display_pending_device', on: ['device_id'], where: null },
  { name: 'IDX_tally_display_pending_secret', on: ['secret_hash'], unique: true, where: null },
])

/** A paired display; `secret_hash` waits for the first collect, which sets `token_hash`. */
export const TallyDisplay = model.define('tally_display', {
  id: model.text().primaryKey(),
  device_id: model.text(),
  name: model.text(),
  cashier_id: model.text(),
  confirmed_at: model.dateTime(),
  last_seen_at: model.dateTime().nullable(),
  token_hash: model.text().nullable(),
  secret_hash: model.text().nullable(),
}).indexes([
  { name: 'IDX_tally_display_device', on: ['device_id'], where: null },
  { name: 'IDX_tally_display_token', on: ['token_hash'], unique: true, where: 'token_hash is not null' },
  { name: 'IDX_tally_display_secret', on: ['secret_hash'], unique: true, where: 'secret_hash is not null' },
])

/** One queued signal; DML has no bigserial type, so `seq` is declared as a number here and bigserial in the migration. */
export const TallyDisplaySignal = model.define('tally_display_signal', {
  seq: model.number().primaryKey(),
  display_id: model.text(),
  device_id: model.text(),
  direction: model.enum(['to_display', 'to_till']),
  type: model.text(),
  payload: model.text(),
}).indexes([{ name: 'IDX_tally_display_signal_inbox', on: ['direction', 'display_id', 'device_id'], where: null }])

/** A display's only snapshot, keyed by the display id. */
export const TallyDisplaySnapshot = model.define('tally_display_snapshot', {
  id: model.text().primaryKey(),
  body: model.text(),
  posted_at: model.dateTime(),
})

/** A failed-claim window: `store`, or `source:` and a `rateLimitSource` key. */
export const TallyDisplayClaimFailure = model.define('tally_display_claim_failure', {
  id: model.text().primaryKey(),
  opened_at: model.dateTime(),
  failures: model.number(),
})

/** Each adoption of a pre-migration device id, with the cashier who registered it. */
export const TallyDisplayAdoption = model.define('tally_display_adoption', {
  id: model.text().primaryKey(),
  device_id: model.text(),
  cashier_id: model.text(),
  adopted_at: model.dateTime(),
})
