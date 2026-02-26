# MedusaPOS

Open source, modular point of sale for [MedusaJS](https://medusajs.com). Built on [TallyUI](https://github.com/TallyUI/tallyui).

> **Beta** — This project is in active development.

## Structure

- `apps/expo` — Expo Router app (iOS, Android, Web)
- `apps/desktop` — Electron desktop wrapper

## Getting Started

```bash
pnpm install
pnpm dev:expo
```

## Tech Stack

- [Expo](https://expo.dev) + [expo-router](https://docs.expo.dev/router/introduction/)
- [TallyUI](https://github.com/TallyUI/tallyui) — composable POS UI primitives
- [RxDB](https://rxdb.info) — local-first reactive database
- [Electron](https://www.electronjs.org) — desktop packaging
