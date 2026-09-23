# Medusa dev store

A local Medusa v2 store for developing and testing MedusaPOS against a real
backend: the Medusa counterpart of the WooCommerce dev sites. It is a dev
fixture, not a workspace package. It has its own npm lockfile and sits
outside the pnpm workspace globs.

It moved here from TallyUI (fe44431). The database, credentials and key title
keep their `tally`/`tallyui` names, so the running store at
`~/Projects/medusa-dev` works unchanged. Run `scripts/deploy.sh` from this
directory to update that store; it rsyncs this tree over the deployed copy and
restarts the server.

- Medusa 2.21.0 (the default `create-medusa-app` backend plus the admin dashboard)
- Postgres 17 and Redis from Homebrew services
- Server bound to `127.0.0.1:9000`; admin at <http://localhost:9000/app>

## Scripts

| Script | What it does |
|---|---|
| `scripts/deploy.sh` | Copies this tree to `$MEDUSA_DEV_HOME` (default `~/Projects/medusa-dev`), runs `npm ci`, and restarts the server. The store runs from that copy, so removing a git worktree never takes it down. |
| `scripts/reset.sh` | Drops the database and rebuilds it: migrations, the deterministic seed, the admin user and the POS API key. |
| `scripts/restart.sh` | Starts Postgres, Redis and the Medusa server. Run it after a reboot. |

First-time setup: `brew install postgresql@17 redis`, then `scripts/deploy.sh`, then `~/Projects/medusa-dev/scripts/reset.sh`.

Dev-only credentials: admin `admin@tally.test` / `tally-dev-admin`. The POS
secret API key is written to `~/Projects/medusa-dev/.pos-api-key`. Send it as
`Authorization: Basic base64(key + ":")`.

## Seed data

`apps/backend/src/scripts/seed-dev-store.ts` runs after the template's
`initial-data-seed` migration script (store, Europe region, EUR/USD, sales
channel, warehouse, four sample products). It adds:

- 2,000 products (`tally-0001` to `tally-2000`, SKUs `TLY-00001…`) across six
  departments and 21 subcategories, plus six collections. Simple products and
  products with variants (Size, Color, Shoe Size, Weight, Scent, Length,
  Finish). Every variant has an EUR and a USD price, a SKU and a valid
  EAN-13 barcode. About 3% of products are drafts, and apparel and homeware
  have images.
- Stock: most variants are tracked with 0–125 units. About 8% are untracked,
  and about 4% allow backorders.
- A "Dev Store Sale" price list: 20% off roughly one product in eight.
- 2,000 customers (`customer0001@tally.test`…), most with an address.
- 300 completed historical orders.
- Each Europe tax region gets its standard VAT rate as the default via
  `seed-tax-rates.ts`: DE 19%, DK 25%, GB 20%, SE 25%, FR 20%, ES 21%, IT 22%.
  The warehouse (and so walk-in POS sales) is in Copenhagen, DK. On an existing
  store, apply this once after `scripts/deploy.sh` by running
  `npx medusa exec ./src/scripts/seed-tax-rates.ts` from
  `~/Projects/medusa-dev/apps/backend`.
- The fixture product `tally-fixture-mug` (SKU `TLY-FIXTURE-MUG`): simple,
  inventory not managed, always sellable. Tests can depend on it, like
  `woo-belt` on the WooCommerce dev sites.

Everything is derived from per-record seeded PRNGs, so `reset.sh` rebuilds the
same catalogue. Re-running the seed on a live store only fills in what is
missing.

## Notes

- `apps/backend/src/api/middlewares.ts` leaves `/store/search` unconfigured.
  The starter's `configureStoreSearch` needs framework 2.21.1, which was under
  a day old when this was set up (the 24h minimum-release-age rule).
- There is no launchd agent for the Medusa server yet; after a reboot, run
  `restart.sh`. Postgres and Redis come back on their own as brew services.
- `AGENTS.md` is the starter template's guide to the Medusa project layout.
