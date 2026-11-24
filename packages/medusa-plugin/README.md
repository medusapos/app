# Medusa POS plugin

Medusa 2.21 plugin for `POST /tally/v1/commands` to ingest POS orders exactly once.
This is a standalone npm package outside the pnpm workspace.

## Install

Requires a Medusa 2.21.0 backend (`@medusajs/framework` and `@medusajs/medusa` peer dependencies at 2.21.0) and Node `^20.19.0 || >=22.12.0`.

In the store's backend directory, run:

```sh
npm install @medusapos/medusa-plugin
```

Add this entry to the `plugins` list in `medusa-config.ts`, keeping any existing plugins:

```ts
plugins: [{ resolve: '@medusapos/medusa-plugin', options: {} }]
```

Then run:

```sh
npx medusa db:migrate
```

Restart the backend. Optional `options` (`salesChannelId`, `locationId`, `shippingOptionId`), till setup, and running more than one Medusa instance are covered in the [quickstart](https://github.com/medusapos/app/blob/main/docs/QUICKSTART.md).

## Develop

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

## Running more than one Medusa instance

More than one Medusa instance requires a shared locking provider: Redis (`@medusajs/medusa/locking-redis`, below) or
Postgres advisory locks (`@medusajs/medusa/locking-postgres`, provider id `locking-postgres`). The plugin serialises stock updates through
Medusa's locking module, and its default in-memory provider only locks inside one process, so concurrent sales on
two instances can lose stock updates and oversell (`integration-tests/http/stock-lock.spec.ts`). While the in-memory
provider is active, the `tally-locking-check` job logs a warning once at startup; the plugin still starts. After
switching to `locking-postgres`, run `npx medusa db:migrate`: it ships a migration that creates its `locking` table
(`@medusajs/locking-postgres/dist/migrations/Migration20241009222919_InitialSetupMigration.js`).

```ts
modules: [{ resolve: '@medusajs/medusa/locking', options: { providers: [{ resolve: '@medusajs/medusa/locking-redis',
  id: 'locking-redis', is_default: true, options: { redisUrl: process.env.LOCKING_REDIS_URL } }] } }]
```

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
`{ commands: CommandEnvelope[] }` containing 1 to `MAX_COMMANDS` commands: `order.create` (version 1, 2, 3, 4 or 5)
or the five register commands (version 1; see [Registers](#registers)).
`MAX_COMMANDS` and `MAX_BODY_BYTES` (`src/api/tally/v1/commands/process.ts`) are the contract's limits. The endpoint parses only `application/json`; a body of any other content type isn't read and gets a `400`.
Every envelope includes `id` (1–64 characters), `type` (one of the six command types), `version`, object `payload`, string `createdAt`
and `deviceId`, and a safe integer `attempt` of at least 1.
A `200 { results: CommandResult[] }` returns one result per command in the same order:
`applied`, `duplicate` with the original `serverRefs` and warnings, or `rejected`.
Reusing an id with a different payload rejects it with
`idempotency_mismatch`; a stored rejection replays as rejected.
A recorded `order.create` id answers its recorded result before version, shape, bounds and fiscal checks; string bounds are email 254 and other strings 255 (customerId 64 and sessionId 36), with no NUL allowed before replay.
`invalid_payload` rejects a malformed payload shape before claiming, with the validation errors in the message. The shape is strict: a field the command's declared version doesn't know is refused by its path (for example `lines[2].discountMinr`), and the keys of a register command's `counted` and `tillExpected` must be `cash` or `external` (ADR 0012). For a register command, it also rejects what the current state refuses after the claim: an unknown session, a missing or already-voided void target, an id that belongs to another session, or a closure whose `registerId` isn't its session's drawer. Neither kind is stored in the ledger, so a resend is checked again.
`store_configuration` rejects a sale the store can't take yet, before any write. Examples: no sales channel, no stock location or address, a `payload.locationId` or plugin option `locationId` that names no stock location or one not assigned to the sale's sales channel, no shipping option at the location for the products' shipping profile, or a sale that mixes shipping profiles. The message names what to fix, it isn't stored, and the same command applies once the store is fixed (ADR 0004). When the sale resumes an order a crashed attempt already started, the same failures are a transient `503` instead, because writes have already happened.
`unsupported_currency`, like `store_configuration`, isn't stored, so the same command can apply once the store is fixed.
`unknown_variant` is stored: a line whose variant or product is deleted, whose product isn't published, or whose product isn't in the sale's sales channel stays rejected even if the product is published or added to the channel later.
An unsupported version is a per-command `unsupported_version` with `error.data` naming the highest supported version (`orderCreate` or `register`).

- `400`: unsupported protocol (`{ code: 'unsupported_protocol' }`) or invalid envelope.
- `401`: no valid admin authentication.
- `413 { code: 'batch_too_large', maxCommands: MAX_COMMANDS, message }`: more than `MAX_COMMANDS` commands; `413 { code: 'body_too_large', maxBytes: MAX_BODY_BYTES, message }`: a JSON body over `MAX_BODY_BYTES` bytes. Nothing is claimed; split the batch and resend.
  The parser reads and discards the whole oversized upload before it answers, so put a proxy body limit in front of the store to stop large uploads early.
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

`GET /tally/v1/info` returns `{ "contracts": { "order.create": [1, 2, 3, 4, 5], "register": [1] } }`, with the same
authentication and CORS as the command endpoint.
It also returns `"taxRounding": { "granularity": "per_order", "mode": "half_away_from_zero" }`: the store rounds tax once per order, half away from zero, so the till computes tax the same way (TallyUI #309).

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

### Automatic promotions and POS orders stored before the fix

A POS order keeps the till's figures: the store's automatic promotions are dropped from it
(#290). Admin draft orders still get them. A dropped promotion leaves no link from the order
to the promotion and no campaign budget usage.

Plugin releases up to 0.3.0 kept those promotions on POS orders. On a store with an active
automatic promotion, each POS order was stored below what the till charged, and Admin shows
the store owing the buyer the difference. **The plugin leaves those orders alone.** Correcting
a stored order is the store owner's accounting decision: an order edit, or a note against
the difference. There are three ways to find them (#295):

- **The ledger.** The sale's `tally_command.result` has a `warnings` entry with code
  `total_mismatch` whose `expectedMinor` is above `serverMinor`, usually next to a
  `figures_mismatch`. `result.serverRefs.orderId` names the order.
- **Admin.** A POS order that was paid in full at the till shows a pending difference in the
  buyer's favour.
- **The database** (read only). A POS order has `tally_pos_totals` in its metadata. It is
  affected when a live adjustment on one of its lines or shipping methods carries a
  `promotion_id`; the till's own adjustments never do.

```sql
SELECT DISTINCT o.id, o.display_id, o.created_at
FROM "order" o
LEFT JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
LEFT JOIN order_line_item_adjustment la
  ON la.item_id = oi.item_id AND la.deleted_at IS NULL AND la.promotion_id IS NOT NULL
LEFT JOIN order_shipping os ON os.order_id = o.id AND os.deleted_at IS NULL
LEFT JOIN order_shipping_method_adjustment sa
  ON sa.shipping_method_id = os.shipping_method_id AND sa.deleted_at IS NULL AND sa.promotion_id IS NOT NULL
WHERE o.deleted_at IS NULL AND o.metadata ? 'tally_pos_totals'
  AND (la.id IS NOT NULL OR sa.id IS NOT NULL)
ORDER BY o.created_at;
```

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
**A parked `order.refund`** (ADR 0026) carries `needs_admin_reason` `{ orderId, clientRefundId, refundId, step, message, reason? }`, where
`step` is where it stopped (`return`, `receive`, `refund`, `park` or `session`). Its `tally_refund` row records what already ran
(`return_id`, `received_at`, `money_started_at`, `medusa_refund_id`). `tally-ledger-resolve.js <commandId> resume` runs the missing
steps and applies the command. Before the receive and again before the money step, the plugin checks that Medusa shows no
more refunded on the payment than `tally_refund` records; if it does, the row parks with `reason: 'refund_unrecorded'`
before stock or money moves. `reason: 'park_unrecorded'` is a parked row whose command park never landed, parked again.
`reason: 'money_unconfirmed'` is a row whose money step started (`money_started_at`) without recording a refund, so no run pays it again: if the provider paid, use `apply`; if it did not, `resume money-not-sent` re-reads Medusa under the order lock, refuses (use `apply`) if a refund the rows do not record has appeared, and otherwise clears `money_started_at` and resumes. It refuses a refund parked for any other reason.
A run that has lost its order lock stops at its next step and leaves its row for the retry. `tally-ledger-resolve.js <commandId> apply
<medusaRefundId>` records a refund the admin made by hand on the order's payment and applies the command. There is no
`reject` for a refund: once a return exists, stock has moved.
`npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-ledger-resolve.js <commandId> move [<sessionId>]` moves a refund whose session stopped taking money to an open session (by default its register's live session), appends a `tally_refund_moves` audit entry without replacing other metadata, then resumes it; a named session on another register logs which drawer pays.
`npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-refunds.js baseline <orderId> <medusaRefundId> [--hand-made] <reason words...>` records a hand-made refund's id, amount, time and required reason in `tally_refund_baselines` for the never-twice check, preserving other metadata; an equal-amount pending till refund requires `apply` if it is its own money, or `--hand-made` if an admin made it, then the admin runs `resume`.
`npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-refunds.js list` lists every parked refund, oldest first, with its order, session, amount, step, reason and update time, followed by every move audit entry with its refund's current status.
**Backfill for rejects made before the marking.** A store needs it only if an admin ran `tally-ledger-resolve reject`
before the release that added the `tally_rejected` marker (#121): those cancelled orders still count in register figures.
The script is manual; nothing runs it automatically. On a real store, plan the run with the store's owner, because it changes
the figures of sessions that may already be closed. Run the dry run first, from the store's backend directory:

```sh
npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-ledger-backfill-rejected.js
npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-ledger-backfill-rejected.js apply
npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-ledger-backfill-rejected.js undo
```

It marks only each rejection's own canceled order and warns about one that is not canceled. Without an argument it is a dry run that writes nothing;
`apply` writes `tally_rejected` and `tally_rejected_by: 'backfill'`, and `undo` removes both from the orders `apply` marked.
The mode is a plain word, not `--apply`: `medusa exec` refuses a dashed option (`Unknown argument: apply`) and drops one given after `--`.
Each run logs each order and each affected register session's expected figures and sales count before and after.
Reading the dry run:
- one `command …, order …, session …: <method> <amount>` line per order it would mark;
- one `session … (open|closed): expected … -> …; salesCount … -> …` line per affected session, where a closed session also
  shows `variance … -> …`, the change an owner will see on that session's report;
- `skipped: no orderId` lines for rejections it can't tie to an order (never guessed);
- a final `would mark <n> order(s), skipped <m> (…)`.

`would mark 0` means there's nothing to do. After `apply`, a second dry run says `would mark 0`, and `undo` puts the figures back.
These commands are the ones `integration-tests/backfill-seed/run.sh` runs in CI against a seeded store (there from the plugin's
own path rather than `node_modules/…`).
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
  - `register_session_superseded`, with `error.data` `{ sessionId, supersededAt, newSessionId, supersededBy?, deviceId?, deviceName? }`, at every contract ([ADR 0022](../../docs/adr/0022-register-v2.md));
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
- **`GET /tally/v1/registers/{id}/closures`** returns `{ closures, more }`: the drawer's closures as submitted, newest first (by closure number). `limit` (1–100, default 50) and `before` (a closure number; pass the last row's `number` for the next page) page it; `from` and `to` (`YYYY-MM-DD`, inclusive) filter on the closure's business day, or its `openedAt` date when the till sent none. Each row carries the stored `tillExpected` and `counted`, not server-derived figures. An unknown register is a `404`; a bad parameter is a `400` with a message. Same authentication, `tally_pos:use` policy and CORS as the routes above.
- **`GET /tally/v1/orders`** returns TallyUI's `StoreOrderPage` (`{ orders, hasMore, total }`): the non-draft orders on the till's sales channel, till sales and others alike, newest first. It is read-only and its money is display-only, in minor units. `page` (from 1) and `perPage` (1–100, default 25) page it; `search` (digits match the order number, anything else Medusa's order search), `status`, `customerId`, `registerId` (the till's device id) and `after`/`before` (ISO instants ending in `Z`) filter it. Core's `cashierId`, `paymentMethod`, `storeId` and `createdVia` get `400 unsupported_order_filter` with the `fields`; a bad parameter is `400 invalid_query`. Same authentication, `tally_pos:use` policy and CORS as the routes above. `allChannels=true` (plugin contract 4) lists every sales channel's orders with the same filters instead of only the till's. It shows full order rows, customer name and email included, from every channel to any user with `tally_pos:use`, matching v2 parity where a WCPOS cashier sees every store order.

**The naming trap:** `order.create`'s `registerId`, stored as order metadata `tally_register_id`, is the **till's device id** (ADR 0017). The register commands, the `tally_register` tables and `/tally/v1/registers/{id}` mean the **drawer**. Never join the two.

## Receipt email

`POST /tally/v1/orders/:id/receipt-email` with `{ email, saveToBilling? }` emails a receipt; `id` is the Medusa order id the till received as `serverRefs.orderId`, and only till orders are accepted. `saveToBilling` is accepted but not applied yet (`savedToBilling: false`).
It sends through the Notification Module on channel `email` with template `tally-pos-receipt`; the store maps that id to its provider's template.
Template `data` contains `order` (money in minor units) and `posTotals` (the till's `tally_pos_totals`).
Responses: 202 accepted; 400 `invalid_payload`; 404 `order_not_found`; 502 `receipt_email_failed`; 503 `receipt_email_unavailable`.
A store needs a Notification Module provider on channel `email`. For a dev store, add this to `defineConfig` (the local provider logs instead of sending): `modules: [{ resolve: '@medusajs/medusa/notification', options: { providers: [{ resolve: '@medusajs/medusa/notification-local', id: 'local', options: { name: 'Local Notification Provider', channels: ['email'] } }] } }]`

## Customer display

These routes implement TallyUI's customer-display signalling seam (`DisplaySignalling`, TallyUI ADR-085): a second device shows the sale to the customer, paired to one till, with WebRTC signalling and a snapshot fallback carried through the store. TallyUI's `displaySignallingContract` runs against them in `integration-tests/http/display-signalling.spec.ts`. The `tally_display` module keeps the devices, codes, pending pairings, displays, signals, snapshots, failed-claim windows and adoptions; it prunes lazily on every call.

**Till side.** Admin authentication and `tally_pos:use`, CORS from `adminCors`, and the capability `customer_display.pair`, which is the policy `tally_pos:pair_display` (in both POS roles; with RBAC off, every POS user holds it). Every call except the first carries the till device in `X-Tally-Device-Id` and `X-Tally-Device-Key`. A call is refused `forbidden`, then `device_refused`, then `not_found`, and a refused call changes nothing.

| Method | Path | Body → answer |
|---|---|---|
| POST | `/tally/v1/display-devices` | `{ deviceId }` → `201 { deviceKey }` (the key is returned this once) |
| POST | `/tally/v1/display-codes` | → `201 { code, expiresAt }` |
| GET | `/tally/v1/display-pairings` | → `200 { pairings }` |
| POST | `/tally/v1/display-pairings/:claimId/confirm` | → `204` |
| POST | `/tally/v1/display-pairings/:claimId/decline` | → `204` |
| GET | `/tally/v1/displays` | → `200 { displays }` |
| DELETE | `/tally/v1/displays/:displayId` | → `204` |
| POST | `/tally/v1/displays/:displayId/signals` | `{ type, payload }` → `204` |
| POST | `/tally/v1/display-signals/drain` | → `200 { signals }` |
| PUT | `/tally/v1/displays/:displayId/snapshot` | `{ snapshot: <any JSON> }` → `204` (body limit 256 kB) |

**Display side.** No login; CORS from `adminCors` (the display page is the app's web origin). The display's token goes only in `X-Tally-Display-Token`, never in a URL.

| Method | Path | Body → answer |
|---|---|---|
| POST | `/tally/v1/display/claim` | `{ code, displayName, token? }` → `201 { claimSecret, checkCode }` |
| POST | `/tally/v1/display/collect` | `{ claimSecret }` → `200 { status: 'pending', checkCode }` or `{ status: 'paired', displayId, token }` |
| POST | `/tally/v1/display/signals` | `{ type, payload }` → `204` |
| POST | `/tally/v1/display/signals/drain` | → `200 { signals }` |
| GET | `/tally/v1/display/snapshot` | → `200 { snapshot }` (`null` when none is held) |

**Errors** are `{ code, message }`, with one fixed message per code that never names a key, token, secret, code or hash: `forbidden` 403, `device_refused` 403, `token_refused` 403, `not_found` 404, `limit` 429, `claim_refused` 403, `collect_refused` 403, `too_large` 413. No plugin refusal is 401: a codeless 401 is Medusa's own missing or expired session. A malformed body is 400 with code `server`; a signal's `type` is `offer`, `answer` or `ice`, and its `payload` a string of at most 65 536 characters.

**Secrets.** Device keys, claim secrets and display tokens are 128 bits from `crypto.randomBytes`, base64url, stored only as SHA-256 hex and compared in constant time. The token is made at a display's first successful collect, so it exists in plaintext only in that answer. Pairing codes are 6 digits from `crypto.randomInt`, single use, live 10 minutes; a device holds at most 5 unspent codes. A snapshot is kept for 60 s, at most 204 800 bytes as `JSON.stringify(snapshot)` gives it. A code is claimable only while unspent and unexpired; the first claim spends it. Displays unseen for 30 days are pruned with their token, snapshot and signals, and devices idle 30 days that own nothing.

**Failed claims** are limited to 10 a minute per source and 100 per 10 minutes store-wide; over either, every claim is refused until the window ends. The source is Express's `req.ip` (an IPv6 address counts by its /64). Medusa sets Express's `trust proxy` to one hop, so `req.ip` is the last `X-Forwarded-For` entry: a store behind exactly one reverse proxy (which sets that header) gets the client's address. A store reached directly, with no proxy in front, lets a client choose its own per-source key with that header, so there the per-source limit is advisory only. What still holds is the store-wide limit and the cashier's confirm of the display's check code on the till. Medusa sets this in its Express loader; the plugin does not change it.

**Advertisement.** `GET /tally/v1/info` carries `customerDisplay: { v: 1, iceServers, snapshot: 1 }`, the shape TallyUI's `parseDisplayAdvertisement` reads. `iceServers` is the plugin option `customerDisplay.iceServers` when it is a valid list (only `stun:`, `stuns:`, `turn:`, `turns:` URLs; a TURN entry needs `username` and `credential`; `[]` means LAN only), else the two default STUN servers, with one warning at start when the option is invalid. The defaults are TallyUI core's: `stun:stun.cloudflare.com:3478` (Cloudflare) and `stun:stun.l.google.com:19302` (Google), so with no option set, the till's and the display's browsers contact those two operators to learn their public addresses. Set `customerDisplay: { iceServers: [] }` to keep display traffic on the local network and contact neither.

**Admin reset.** From the store's directory, `npx medusa exec node_modules/@medusapos/medusa-plugin/.medusa/server/src/scripts/tally-display-reset.js <deviceId>` deletes that till device with every display, token, snapshot, code, pending pairing and signal it owns, so the id registers as a new device. Use it for a lost or replaced till; its displays pair again.

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
