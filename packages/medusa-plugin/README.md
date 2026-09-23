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
Replays reuse a non-canceled order with the same `metadata.tally_client_id`; leftover drafts
are deleted before retrying. Insufficient stock returns a rejection; other workflow errors throw.
The HTTP endpoint and ledger claim/complete calls remain for A4; callers must serialize
concurrent commands until that ledger wiring is in place.

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
