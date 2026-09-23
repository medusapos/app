# Medusa POS plugin

Medusa 2.21 plugin for `POST /tally/v1/commands` to ingest POS orders exactly once.
The endpoint is not built yet. This is a standalone npm package outside the pnpm workspace.

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
HTTP integration tests boot the minimal app in `integration-tests/app` on a random port
and create/drop their own temporary database; they do not use the dev store.

## Order creation workflow

`runOrderCreate(container, command, options?)` is exported from `@medusapos/medusa-plugin/workflows`.
It resolves Medusa data, validates with the pure planner, and runs `tallyOrderCreateWorkflow`:
draft → convert → collect the POS total → mark paid → fulfill → complete.
The payment collection uses `totalMinor` exactly, including when Medusa's unrounded
tax total differs; the result reports the rounded server total and any `total_mismatch` warning.
Payments use the system provider, which moves no money. Later failures compensate
the order and inventory; capture itself has no refund compensation.
Options `salesChannelId`, `locationId`, and `shippingOptionId` override the store/channel
defaults and the location's earliest shipping option; payload `locationId` takes precedence.
Stock never rejects an offline sale: availability is checked at the sale location, shortfalls
are temporarily added before the draft and taken back after fulfillment, with compensation.
Stock ends at original minus sold and may go negative. Each short variant gets an
`insufficient_stock` warning whose quantity is the shortfall, after any `total_mismatch`.
Replays trust only completed live orders with the same `metadata.tally_client_id`.
Half-made orders resume conversion, payment, remaining fulfillment, recorded stock take-back,
and completion on the same order, never cancelling or deleting it; resume errors throw for retry.
The stock rejection mapping remains as a fallback for other Medusa refusals.
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
The HTTP endpoint remains for A4.

## Ledger module

The `tally_ledger` module stores commands in `tally_command` with columns `id`
(the client's UUIDv7 idempotency key), `type`, `fingerprint` (SHA-256 of canonical
JSON of `{ type, version, payload }`), `claim_token`, `status`, nullable JSON `result`, and
automatic `created_at`, `updated_at`, and `deleted_at` timestamps.
Statuses are `in_progress` (the default), `applied`, and `rejected`.
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
