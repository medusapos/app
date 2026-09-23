# Medusa POS plugin

Medusa 2.21 plugin for `POST /tally/v1/commands` to ingest POS orders exactly once.
The endpoint is not built yet. This is a standalone npm package outside the pnpm workspace.

Run from this directory:
```sh
npm ci
npm run typecheck
npm run test:unit -- --maxWorkers=2
npm run test:integration:modules -- --maxWorkers=1
npm run db:generate
npm run build
```
Module integration tests need local Postgres; set `DB_HOST`, `DB_USERNAME`, and `DB_PASSWORD`.
The test helper defaults to role `postgres`; use `DB_USERNAME=claude` if that is your local role.

## Ledger module

The `tally_ledger` module stores commands in `tally_command` with columns `id`
(the client's UUIDv7 idempotency key), `type`, `fingerprint` (SHA-256 of canonical
JSON of `{ type, version, payload }`), `status`, nullable JSON `result`, and
automatic `created_at`, `updated_at`, and `deleted_at` timestamps.
Statuses are `in_progress` (the default), `applied`, and `rejected`.
`claim` atomically inserts a command or returns the existing row unchanged, with a `claimed` flag.
`complete` records a status and result only for an in-progress command, throwing `NOT_FOUND` for an unknown id or `NOT_ALLOWED` for a finished command.
`release` hard-deletes only in-progress commands so they can be claimed again, leaving finished and unknown ids alone.
