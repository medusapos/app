# Medusa POS plugin

Medusa 2.21 plugin for `POST /tally/v1/commands` to ingest POS orders exactly once.
This is a standalone npm package outside the pnpm workspace.

Run from this directory:
```sh
npm ci
npm run typecheck
npm run test:unit -- --maxWorkers=2
npm run test:integration:modules -- --maxWorkers=1
npm run test:integration:http -- --maxWorkers=1
npm run db:generate
npm run build
```
Module integration tests need local Postgres; set `DB_HOST`, `DB_USERNAME`, and `DB_PASSWORD`.
The test helper defaults to role `postgres`; use `DB_USERNAME=claude` if that is your local role.
Set `MEDUSA_DISABLE_TELEMETRY=true` and `XDG_CONFIG_HOME=$PWD/.medusa/xdg` for Medusa commands.
HTTP integration tests boot the apps in `integration-tests/app` and `integration-tests/plugin-app`
and create/drop their own temporary databases; they do not use the dev store.
For `npm run test:integration:http`, CI uses random ports; outside CI each checkout gets its own block of 4 ports (in 40000–47999, one per jest worker, so at most 4 workers), printed at the start of the run, and setting `PORT` overrides it. A port held on 127.0.0.1, ::1, 0.0.0.0 or :: stops the run before any test, naming the port and each busy address. Running `jest <spec>` directly (without the npm script, so without `TEST_TYPE`) skips the port block and this check.
The HTTP test script builds the plugin first so `plugin-app` loads its published output.

## Command endpoint

Register the plugin in the tester's `medusa-config.ts`:

```ts
plugins: [{
  resolve: '@medusapos/medusa-plugin',
  options: {
    // Optional: salesChannelId, locationId, shippingOptionId
  },
}]
```

Run `npx medusa db:migrate`. Add the hosted POS origin to both `ADMIN_CORS` and
`AUTH_CORS`. Have a shipping option at the POS stock location on the POS products' shipping
profile, or set `shippingOptionId`.
The optional `salesChannelId` and `locationId` select the POS sales channel and stock location.
Sign in as a Medusa admin user through `/auth/user/emailpass` and send its JWT as
`Authorization: Bearer <jwt>` (an authenticated admin session is also accepted).

Send `POST /tally/v1/commands` with `X-Tally-Protocol: 1` and JSON
`{ commands: CommandEnvelope[] }` containing 1–50 commands: `order.create` (version 1, 2 or 3)
or the five register commands (version 1; see [Registers](#registers)).
Every envelope includes `id` (1–64 characters), `type` (one of the six command types), `version`, object `payload`, string `createdAt`
and `deviceId`, and a safe integer `attempt` of at least 1.
A `200 { results: CommandResult[] }` returns one result per command in the same order:
`applied`, `duplicate` with the original `serverRefs` and warnings, or `rejected`.
Reusing an id with a different payload rejects it with
`idempotency_mismatch`; a stored rejection replays as rejected.
A recorded `order.create` id answers its recorded result before version, shape, bounds and fiscal checks; string bounds are email 254 and other strings 255 (customerId 64 and sessionId 36), with no NUL allowed before replay.
`invalid_payload` rejects a malformed payload shape before claiming, with the validation errors in the message. For a register command, it also rejects what the current state refuses after the claim: an unknown session, a missing or already-voided void target, an id that belongs to another session, or a closure whose `registerId` isn't its session's drawer. Neither kind is stored in the ledger, so a resend is checked again.
`store_configuration` rejects a sale the store can't take yet, before any write. Examples: no sales channel, no stock location or address, no shipping option at the location for the products' shipping profile, or a sale that mixes shipping profiles. The message names what to fix, it isn't stored, and the same command applies once the store is fixed (ADR 0004). When the sale resumes an order a crashed attempt already started, the same failures are a transient `503` instead, because writes have already happened.
`unsupported_currency`, like `store_configuration`, isn't stored, so the same command can apply once the store is fixed.
`unknown_variant` is stored: a line whose variant or product is deleted, whose product isn't published, or whose product isn't in the sale's sales channel stays rejected even if the product is published or added to the channel later.
An unsupported version is a per-command `unsupported_version` with `error.data` naming the highest supported version (`orderCreate` or `register`).

- `400`: unsupported protocol (`{ code: 'unsupported_protocol' }`) or invalid envelope.
- `401`: no valid admin authentication.
- `413 { code: 'batch_too_large', maxCommands: 50, message }`: more than 50 commands; `413 { code: 'body_too_large', maxBytes: 1048576, message }`: a JSON body over 1 MB. Nothing is claimed; split the batch and resend.
- `409 { code: 'in_progress', id }`: this command is already being processed.
- `503 { code: 'transient', id, message }`: execution failed; its claim is released for retry.

A `409` or `503` stops the batch at that command. Retry the whole batch; earlier
completed commands replay as duplicates. Network errors, `5xx`, and `429` are also
retryable. Preflight `OPTIONS` needs no authentication; CORS uses `ADMIN_CORS` and
allows `Authorization`, `Content-Type`, and `X-Tally-Protocol`.

Version 2 (TallyUI ADR-062) adds discounts: `lines[].discountMinor` (the line's discount in its
own tax mode) and `discountMinor`, their sum; both positive when present. Version 2 without
`discountMinor` is `invalid_payload`. Each discounted line gets one code-less Medusa line-item
adjustment, "POS discount", in the line's tax mode, so tax is charged on the discounted amount.

Version 3 (TallyUI ADR-065) adds optional fields:
- `display` and `taxByRate`, both or neither: the receipt's own figures, stored as sent in `tally_pos_totals` v2 as the fiscal record (ADR 0012);
- `sessionId`, the register session, stored as `tally_session_id`;
- `customer.customerId`, the Medusa customer. When that customer exists, the order uses it without the till's email; otherwise the order uses the till's email as before. `tally_customer_id` is stored either way.

`GET /tally/v1/info` returns `{ "contracts": { "order.create": [1, 2, 3], "register": [1] } }`, with the same
authentication and CORS as the command endpoint.

## Order creation workflow

`runOrderCreate(container, command, options?, ledger?)` is exported from `@medusapos/medusa-plugin/workflows`.
The command endpoint passes `ledger` (the claim token and any top-ups a crashed attempt
applied) so stock top-ups are recorded on the command's ledger row (ADR 0003 amendment);
without it, nothing is recorded there.
It resolves Medusa data, validates with the pure planner, and runs `tallyOrderCreateWorkflow`:
draft → convert → collect the POS total → mark paid → fulfill → complete.
Each draft item is tax-inclusive per its line's optional `taxInclusive`, else the payload's `pricesIncludeTax`.
The payment collection uses `totalMinor` exactly, including when Medusa's unrounded
tax total differs; the result reports the rounded server total and any `total_mismatch` warning.
Payments use the system provider, which moves no money. Later failures compensate
the order and inventory; capture itself has no refund compensation.
Options `salesChannelId`, `locationId`, and `shippingOptionId` override the store/channel
defaults and the automatic shipping option; payload `locationId` takes precedence.
The automatic shipping option is the location's earliest one on the sale's products' shipping profile.
A sale's products may use at most one shipping profile (products without one are ignored);
otherwise it's a `store_configuration` rejection. An explicit
`shippingOptionId` must use the products' profile.
Stock never rejects an offline sale: availability is checked at the sale location, shortfalls
are temporarily added before the draft and taken back after fulfillment, with compensation.
Stock ends at original minus sold and may go negative. Each short variant gets an
`insufficient_stock` warning whose quantity is the shortfall, after any `total_mismatch`.
Replays trust only completed live orders with the same `metadata.tally_client_id`.
Half-made orders resume conversion, payment, remaining fulfillment, recorded stock take-back,
and completion on the same order, never cancelling or deleting it; resume errors throw for retry.
A stock refusal from Medusa is treated as a race and retried, never a rejection.
Known limit: a channel with several stock locations may reserve at another location than
the sale's; the dev store has one. See [the stock ADR](../../docs/adr/0003-offline-sale-stock.md).

## Command execution

`executeOrderCreate(container, command, options?)` in `workflows/tally-order-create` fingerprints
and claims the command, then holds a Postgres session advisory lock for its `clientOrderId`
on a dedicated connection through the run and completion. It re-checks the claim token
after acquiring the lock, so an expired worker cannot start after a re-claim.
Outcomes are `result` (applied, duplicate with original references and warnings, or rejected),
`in_progress` (retryable 409), and `transient` (503 with the thrown error's message).
Failures release the claim for retry; a completed order is deduplicated on the next run.
The connection is always unlocked and released; a process crash drops the lock.

## Ledger module

The `tally_ledger` module stores commands in `tally_command` with columns `id`
(the client's UUIDv7 idempotency key), `type`, `fingerprint` (SHA-256 of canonical
JSON of `{ type, version, payload }`), `claim_token`, `status`, nullable JSON `result`, and
automatic `created_at`, `updated_at`, and `deleted_at` timestamps.
Statuses are `in_progress` (the default), `applied`, `rejected`, and `needs_admin`.
`claim({ id, type, fingerprint }, context?)` atomically inserts or re-claims an
`in_progress` command after a 120 s lease on `updated_at`, only for the same fingerprint.
It returns `{ claimed: true, claimToken, command }` on success, otherwise
`{ claimed: false, command }`. A concurrent release before the read raises retryable `CONFLICT`.
`complete(id, claimToken, result, context?)` validates a TallyUI `CommandResult`
with matching id and `applied` or `rejected` status, then writes only for the current token.
Invalid results raise `INVALID_DATA`; unknown ids raise `NOT_FOUND`; finished or lost claims raise `NOT_ALLOWED`.
Stored results are parsed with the same validator when returned by claim or complete.
`release(id, claimToken, context?)` hard-deletes only an `in_progress` command
with the current token. Stale tokens, finished commands and unknown ids are left alone.
See [the lease ADR](../../docs/adr/0001-command-ledger-lease.md).

`needs_admin`: a reclaimed `order.create` that finds its order in a state the recipe never creates (a refund, a partial
capture, a non-system payment provider or a canceled fulfilment) stops before any write. The row is parked with
`needs_admin_reason` (`{ orderId, clientOrderId, detail }`) and one error log line, `claim` never reclaims it, and the till gets `409 in_progress`
on every resend. The script builds to `.medusa/server/src/scripts/tally-ledger-resolve.js` (checked after `npm run build`);
from the store's directory an admin runs `npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-ledger-resolve.js <commandId> apply|reject [message]`:
`apply` (order fixed) makes the row reclaimable at once, so the next resend resumes it. `reject` first takes back any stock
top-up the plugin made for the sale and hasn't reversed (ADR 0003), then cancels the sale's live order with
`cancelOrderWorkflow`, then stores a `platform_error` rejection (`data.platformCode: 'TALLY_ADMIN_REJECTED'`) that resends
replay; a new command id for the same sale then creates a new order. If the take-back or the cancel fails (for example an
uncanceled fulfilment), the script logs it, exits non-zero and leaves the row `needs_admin`: clean the order up by hand and
run `reject` again, not `apply`: an `apply` would leave the cancelled order unmarked, and it would count next to the new one.
Cancelling the order by hand is fine: `reject` still takes back the plugin's top-up. See the ADR 0003 amendment of 2026-09-29.
`reject` marks the canceled order `tally_rejected`, and register figures skip it.
A new command id for the same live `clientOrderId` copies the original applied result, including its warnings,
and stores it for duplicate replays; a superseded original copies its applied successor's result.
A fresh lease or `needs_admin` row answers 503 without storing the new command; a busy sale lock or lost takeover
answers 409. A stale lease is taken over, the order resumes under the new command, and the original becomes
`superseded` by it, so resending the original returns the new result as a duplicate. A rejected original with
a live order answers 503 and logs an error; an order without a ledger row resumes as orphan recovery.

## Registers

TallyUI registers c2 syncs a till's drawer to the store: sessions, cash movements and closures (the Z). The contract is TallyUI ADR-068, and the plugin's design is [ADR 0019](../../docs/adr/0019-registers-on-the-server.md).
- **Five commands** go through the command endpoint and its ledger, at version 1: `register.session.open`, `register.session.transition`, `register.movement.record`, `register.movement.void` and `register.closure.submit`.
- **The `tally_register` module** stores them in `tally_register`, `tally_register_session`, `tally_register_movement` and `tally_register_closure`.
  - Unique indexes enforce one non-closed session per register, one closure per session, unique closure numbers and one void per movement.
  - Row locks in the service enforce gap-free closure numbers and no movement after its session's closure.
- **Business refusals** are per-command rejections, stored in the ledger so a replay returns them:
  - `register_session_already_open`, with `error.data.sessionId`;
  - `register_session_closed`, with no data;
  - `register_closure_exists`, with `error.data.closureId`;
  - `register_closure_number_invalid`, with `error.data.counters`.
- **Commands apply in the order received.** `at` and `createdAt` are never compared. Any transition is accepted except one out of `closed`, and a same-status transition is a no-op. Every operation is replay-safe by its till-minted id.
- **Server figures:**
  - session results carry `session.expected` (per tender) and `session.salesCount`;
  - `register.closure.submit` results carry `closure.expected` and `closure.variance` (counted − expected), with no `salesCount`.
  - They're derived from the orders' `tally_payments` and the session's movements.
  - Orders count when completed, archived or canceled.
  - **Before the closure, only orders whose `tally_session_id` is the session count**, which means `order.create` v3 sales with a `sessionId`. A v1 or v2 sale doesn't show up until the closure.
  - After the closure, the closure's `orderIds` decide.
  - The till's own `tillExpected` and `counted` are stored unchanged as the fiscal record.
- **`GET /tally/v1/registers/{id}`** (the drawer id) returns `{ counters, session? }`: the register's counters, plus its latest session (the non-closed one first) with `expected` and `salesCount`. An unknown register is a `404`. It uses the same admin authentication and CORS as the command endpoint.

**The naming trap:** `order.create`'s `registerId`, stored as order metadata `tally_register_id`, is the **till's device id** (ADR 0017). The register commands, the `tally_register` tables and `/tally/v1/registers/{id}` mean the **drawer**. Never join the two.

## Experimental sync (G4)

This is a change journal and two read routes for TallyUI's G4 sync experiment. The design is [ADR 0020](../../docs/adr/0020-medusa-side-of-g4-sync.md), and the event evidence is the [G4 events spike](../../docs/spikes/g4-medusa-events.md). **It's experimental and unversioned:** the route shapes and the `sync: [1]` capability may change without a version bump until TallyUI's G2 names the driver interface. **It's off by default.**

- **The switch** is the plugin option `experimentalSync: true`. When it's off, the subscriber writes nothing, both routes answer `404`, and `/tally/v1/info` doesn't list `sync`. The dev store reads it from `TALLY_EXPERIMENTAL_SYNC=1`.
- **The `tally_sync` module** keeps:
  - a `tally_change` journal (a gap-free `bigserial` `seq`, the collection, the object id, and `upsert` or `delete`);
  - a one-row `tally_sync_state` (the epoch and the price-list watermark).

  The first route call mints the epoch and backfills one `upsert` row per live product, once. There's no retention in G4.
- **What feeds the journal:**
  - One subscriber listens to the module entity events for products, variants, options and option values, prices, inventory levels and items, and to the product↔sales-channel, variant↔price-set and variant↔inventory-item link events. It resolves each to its product ids. The op is `delete` when the product is soft-deleted, `upsert` otherwise.
  - **Price lists emit no event** when they're updated, change status, or start or end. A watcher covers them: it runs on every `/changes/tick` (at most once every 5 s per process) and every minute as a scheduled job. It journals the products of any price list whose `updated_at` passed the watermark, or whose `starts_at` or `ends_at` fell since the last run.
- **`GET /tally/v1/changes?since=&limit=&collections=&epoch=`** returns `{ epoch, head, horizon, changes: [{ seq, collection, id, op, revision }], more }`. A cursor from another epoch, one ahead of `head`, or `since > 0` without an `epoch`, gets `410 { code: 'cursor_expired', epoch, head }`.
- **`GET /tally/v1/changes/tick?since=&epoch=`** returns `304` when nothing changed, otherwise `{ epoch, head, horizon }`.
- Both routes use the same admin authentication and CORS as the command endpoint.

**Only writes made by the server (or its workers) are journaled.** Events reach subscribers in the process that wrote. On the local bus they never leave it, and on the Redis bus they're dropped at the emitter when that process has no subscriber for them (spike findings).
- **`medusa exec` scripts are not journaled.** On the local bus, 5 of 5 direct price writes from `medusa exec` committed, and none reached the journal: no subscriber ran before the script exited.

  **Catch up with a rescan** after an import, a script or raw SQL, from the store's backend directory: `npx medusa exec ./node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-sync-rescan.js <since>`. `since` is a required ISO timestamp that must include a timezone (`Z` or `±hh:mm`, e.g. `2026-09-29T10:00:00Z`): use the time the import or script started, a little earlier to be safe; duplicates are harmless. It journals every product whose row, variants, prices, inventory items or levels, options, option values, inventory-item and price-set links, or sales-channel links have an `updated_at` or `deleted_at` after `since`. A soft-deleted product gets `delete`, any other `upsert`. It doesn't cover price lists, which are the watcher's job (any `/changes/tick` runs it), or hard-deleted rows. With `experimentalSync` off it does nothing, and before the first route call it logs `journal not initialized`. The path above assumes the plugin is installed under the backend's own `node_modules`; in a hoisted monorepo, point `medusa exec` at wherever `@medusapos/medusa-plugin` resolves instead, for example with `node -p "require.resolve('@medusapos/medusa-plugin/package.json')"` (documentation only, not something we run).
- **Catalogue changes made by a script** reach tills through a rescan, or sooner through a later edit of the same products. Before initialization, the install backfill covers them.
- **A demo reset** clears the journal and the sync state, so the next route call mints a new epoch. Every till's cursor then answers `410 cursor_expired`, and the till resyncs.

**Journal ordering:** every journal write takes one advisory lock, so `seq` order is commit order and a cursor never skips a row. The lock wait is capped at 10 s. An event that times out is retried once, then logged as `tally_sync: journal lock timeout: … dropped` with its event name and id.

**Not covered**, so these reach tills only through a later edit (or, from P3, the digest audit):
- writes from `medusa exec` scripts or any other process that doesn't run the server, and raw SQL;
- rows Medusa hard-deletes (a price removed through a price-set update, option values, product↔option links), when no sibling event fires. Every admin workflow measured does fire one.
- a price-list change whose transaction commits longer than 10 s after its `updated_at` (the watermark lags `now()` by 10 s);
- an event dropped after its lock-timeout retry;
- an event lost if the process crashes between the commit and the subscriber (ADR 0020, E2.1).
