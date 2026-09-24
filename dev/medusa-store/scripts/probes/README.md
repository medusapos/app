# Medusa replication probes

Manual probes that produced the evidence behind TallyUI ADR-060: in Medusa
2.21, deleting a variant does not bump the product's `updated_at`, and
`GET /admin/products` honours `updated_at[$gte]` but silently ignores the
plain `updated_at[gte]` form that TallyUI's replication pull uses. Kept here
so anyone can rerun them and reproduce the evidence. `variant-price-edit.sh`
answers a later question for TallyUI's Medusa price sync: whether a price-only
edit bumps the variant's `updated_at`.

**Only ever point these at the disposable e2e store.** `variant-delete.sh`
and `variant-price-edit.sh` create and delete a real product against
whatever `PROBE_BASE_URL` points at. Never run either probe against a shared or production store.

## Start the disposable e2e store

From the repo root:

```sh
bash e2e/store/start.sh
```

This drops and recreates the `medusapos_e2e` database, seeds it, creates the
`e2e@tally.test` admin user, and serves the store on `http://127.0.0.1:9100`.
Leave it running in that terminal; run the probes from another one.

## Run a probe

Each probe reads its target and credentials from the environment, defaulting
to the e2e store started above:

- `PROBE_BASE_URL` — default `http://127.0.0.1:9100`
- `PROBE_EMAIL` — default `e2e@tally.test`
- `PROBE_PASSWORD` — default `e2e-password`

```sh
dev/medusa-store/scripts/probes/variant-delete.sh
dev/medusa-store/scripts/probes/updated-at-filter.sh
dev/medusa-store/scripts/probes/variant-price-edit.sh
```

### `variant-delete.sh`

Creates a two-variant product, records `updated_at`, deletes one variant,
and records `updated_at` again, printing both values plus a
`GET /admin/products?updated_at[gte]=<mark>` listing taken right after the
delete (the form TallyUI's pull queries; see `updated-at-filter.sh` —
Medusa ignores this plain form, so the listing returns every product
regardless of the delete). The evidence is that `updated_at` is unchanged
before and after the delete: an incremental pull correctly filtered on
`updated_at` (`updated_at[$gte]`) would not see the change, because the
product's `updated_at` never moved. The probe cleans up by deleting the
product it created.

### `updated-at-filter.sh`

Read-only. Queries `GET /admin/products` once with `updated_at[gte]=<a
future timestamp>` and once with `updated_at[$gte]=<the same timestamp>`,
printing the HTTP status and a trimmed response for each. A future timestamp
should match nothing; if `updated_at[$gte]` returns `count: 0` while
`updated_at[gte]` returns every product, that confirms Medusa only honours
the `$gte` form and silently ignores the plain one.

### `variant-price-edit.sh`

Creates a one-variant product with an EUR price, then edits only that price
twice: first through `POST /admin/products/:id/variants/batch` (the route the
admin dashboard's price editor uses), then through
`POST /admin/products/:id/variants/:variant_id`. Before and after each edit it
prints the variant's `updated_at`, its prices' `updated_at` (read through
`GET /admin/product-variants`) and the product's `updated_at`, then deletes
the product. On Medusa 2.21.0 (2026-09-24) both routes moved the variant's
`updated_at` and the price's `updated_at`; the product's `updated_at` did not
move. So a feed filtered on the variant's `updated_at` sees price edits, and
one filtered on the product's `updated_at` does not.
