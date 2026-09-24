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
it. The `@tallyui/*` packages come from a TallyUI checkout **next to this
repo** (`../tallyui`), through `pnpm.overrides` in the root `package.json`.
The published npm versions predate the APIs the app needs, and
`@tallyui/primitives` is not published. The app compiles TallyUI from source
(`src/index.ts`, via tsconfig `paths` and a Metro resolver), so the checkout
does not need a build. When TallyUI publishes, delete the `overrides` block
and those two resolver hooks.

## Getting Started

Testing the hosted app? Follow the [tester quick-start](docs/QUICKSTART.md).

```bash
git clone https://github.com/TallyUI/tallyui.git ../tallyui   # once
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

- Replicated stock levels and prices are a snapshot from the first sync and are not refreshed when only stock or prices change. Do not treat the stock shown in the POS as live. Sales are still recorded correctly: the server checks and tops up stock when recording each sale (see [ADR 0003](docs/adr/0003-offline-sale-stock.md)). A TallyUI fix is in progress under ADR-060.

## Tech Stack

- [Expo](https://expo.dev) + [expo-router](https://docs.expo.dev/router/introduction/)
- [TallyUI](https://github.com/TallyUI/tallyui) — composable POS UI primitives
- [RxDB](https://rxdb.info) — local-first reactive database
- [Electron](https://www.electronjs.org) — desktop packaging
