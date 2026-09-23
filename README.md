# MedusaPOS

Open source, modular point of sale for [MedusaJS](https://medusajs.com). Built on [TallyUI](https://github.com/TallyUI/tallyui).

> **Beta** — This project is in active development.

## Structure

- `apps/expo` — Expo Router app (iOS, Android, Web). Current scope: a product
  lookup. Every product is replicated from a Medusa store into a local RxDB
  database, listed with price and stock, and searchable by name, SKU or barcode.
- `apps/desktop` — Electron desktop wrapper
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

```bash
git clone https://github.com/TallyUI/tallyui.git ../tallyui   # once
pnpm install
```

Run the app against the dev store (start the store with
`~/Projects/medusa-dev/scripts/restart.sh`; see `dev/medusa-store/README.md`):

```bash
cp apps/expo/.env.example apps/expo/.env.local
# set EXPO_PUBLIC_MEDUSA_API_KEY to the contents of ~/Projects/medusa-dev/.pos-api-key
pnpm --filter @medusapos/expo web   # http://localhost:8081 (the store's CORS allows this port)
```

The API key is inlined into the web bundle, which is acceptable only for the
localhost dev store. A real register needs a user sign-in flow.

## Tech Stack

- [Expo](https://expo.dev) + [expo-router](https://docs.expo.dev/router/introduction/)
- [TallyUI](https://github.com/TallyUI/tallyui) — composable POS UI primitives
- [RxDB](https://rxdb.info) — local-first reactive database
- [Electron](https://www.electronjs.org) — desktop packaging
