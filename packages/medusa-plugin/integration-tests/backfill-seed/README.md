# Backfill seed: a real run of tally-ledger-backfill-rejected

`run.sh` shows the rejected-order backfill as an operator runs it: `npx medusa exec` of the built script against a
real database, with the real output. It:

1. creates a fresh local database (`createdb`);
2. builds the plugin (`npm run build`);
3. migrates it with `npx medusa db:migrate`, using `plugin-app/medusa-config.ts` unchanged. The medusa CLI only runs
   where a `package.json` names `@medusajs/medusa`, so a throwaway project under the log directory loads that config;
4. seeds it with `npx medusa exec` of `seed.ts`, which drives the plugin's own code paths (`processBatch`, the
   register commands, `tally-ledger-resolve reject`) as the integration tests do:
   - open session S1: a sale parked as `needs_admin`, rejected and then unmarked (a reject made before #121), and an
     ordinary sale that stays counted;
   - closed session S2 (the #121 review case): c0 applied then canceled by hand, c1 for the same `clientOrderId`
     parked, rejected and unmarked, and a closure whose `orderIds` lists that sale;
   - a `TALLY_ADMIN_REJECTED` ledger row with no `orderId`;
5. runs the backfill five times (dry run, `apply`, dry run, `undo`, dry run), printing a `=== <n>. <command>`
   header and the backfill's own lines to stdout. These are the three commands the plugin README gives an operator,
   with this project's path. The mode is a plain word: `medusa exec` refuses `--apply` and drops `-- --apply`;
6. drops the database, unless `KEEP_DB=1`.

It fails unless run 1 says `would mark 2` and skips the rejection with no `orderId`, run 2 says `marked 2`, run 3
`would mark 0`, run 4 `unmarked 2`, and run 5's order and session lines equal run 1's. CI runs it in the
`medusa-plugin` job. Everything else goes to `/tmp/medusapos-backfill-seed-<pid>/run.log`.

## Run

From `packages/medusa-plugin`:

```sh
DB_USERNAME=claude MEDUSA_DISABLE_TELEMETRY=true bash integration-tests/backfill-seed/run.sh
```

`DB_HOST` (default `localhost`), `DB_PORT` (`5432`), `DB_USERNAME` (`postgres`), `DB_PASSWORD` and `DB_NAME`
(`medusapos_backfill_seed`) choose the database. It refuses any host but `localhost` or `127.0.0.1`, and any name
that does not start with `medusapos_backfill_seed`.
