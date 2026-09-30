# MedusaPOS

Open source, modular point of sale for [MedusaJS](https://medusajs.com). Built on [TallyUI](https://github.com/TallyUI/tallyui).

> **Beta** — This project is in active development.

## Structure

- `apps/expo` — Expo Router app (iOS, Android, Web). Current scope: a product
  lookup. Every product is replicated from a Medusa store into a local RxDB
  database, listed with price and stock, and searchable by name, SKU or barcode.
- `apps/desktop` — Electron desktop wrapper
- `packages/medusa-plugin` — the Medusa 2.21 plugin that ingests POS orders;
  outside the pnpm workspace with its own npm lockfile, like the dev store. See
  its README.
- `dev/medusa-store` — a Medusa 2.21 dev store with a deterministic seed
  (2,000 products, 2,000 customers, 300 orders). It sits outside the pnpm
  workspace and has its own npm lockfile. See its README.

## TallyUI

TallyUI stays platform-agnostic, and this repo holds the Medusa POS built on
it. All eight `@tallyui/*` packages come from npm, pinned at exactly `2.0.0`
in the root `package.json`'s `pnpm.overrides` and `apps/expo/package.json`.
The app compiles TallyUI from each npm package's shipped `src/`, using the
`source` export condition, tsconfig `paths` and the Metro resolver.
To bump TallyUI, change all eight versions in both files and run `pnpm install`.
`apps/expo/tests/tallyui-dependencies.test.ts` enforces this rule.

## Getting Started

Testing the hosted app? Follow the [tester quick-start](docs/QUICKSTART.md).

```bash
pnpm install
```

Run the app against the dev store (start the store with
`~/Projects/medusa-dev/scripts/restart.sh`; see `dev/medusa-store/README.md`):

```bash
cp apps/expo/.env.example apps/expo/.env.local
pnpm --filter @medusapos/expo web   # http://localhost:8081 (the store's CORS allows this port)
```

Sign in with the store's backend URL and an admin user. For the dev store,
use `http://localhost:9000` and `admin@tally.test`; the password is in
`dev/medusa-store/scripts/lib.sh`. The backend's `AUTH_CORS` and `ADMIN_CORS`
must include the app's origin (`http://localhost:8081` for local development).

## Known limitations

- Stock is checked against the store every 5 minutes and when the app returns to the foreground (TallyUI ADR-060), so the stock shown in the POS is live within that cadence; each variant's stock label says when it was last checked. Prices are re-checked against the store every 30 minutes, and base prices nightly, so a price change reaches the POS within that cadence even when nothing else about the product changed. Sales are recorded correctly either way: the server checks and tops up stock when recording each sale (see [ADR 0003](docs/adr/0003-offline-sale-stock.md)).
- Catalogue sync is incremental; deleted products and variants are removed by a check at app start and every 24 hours while the app stays open.

## Tech Stack

- [Expo](https://expo.dev) + [expo-router](https://docs.expo.dev/router/introduction/)
- [TallyUI](https://github.com/TallyUI/tallyui) — composable POS UI primitives
- [RxDB](https://rxdb.info) — local-first reactive database
- [Electron](https://www.electronjs.org) — desktop packaging
