# Medusa POS plugin

Medusa 2.21 plugin for `POST /tally/v1/commands` to ingest POS orders exactly once.
The endpoint is not built yet. This is a standalone npm package outside the pnpm workspace.

Run from this directory (after the initial npm lockfile has been created):
```sh
npm ci
npm run typecheck
npm run test:unit -- --maxWorkers=2
npm run test:integration:modules -- --maxWorkers=1
npm run db:generate
npm run build
```
Module integration tests need local Postgres; set `DB_HOST`, `DB_USERNAME`, and `DB_PASSWORD`.
