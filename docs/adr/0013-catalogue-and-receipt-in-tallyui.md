# The catalogue, receipt, print style and sync status come from @tallyui/components

Status: Accepted
Date: 2026-09-25

## Context

`apps/expo/components/catalogue.tsx`, `receipt.tsx`, `sync-status.tsx` and
`print-style.ts` were the app's own copies of the product catalogue, the
receipt, the print-style hook and the outbox sync status line. TallyUI
lifted them into `@tallyui/components` (TallyUI ADR-052/065, TV6b, #141):
`Catalogue`, `formatStockSyncTime`, `Receipt`, `injectPrintStyle` and
`SyncStatus` are now exported from the package root, adapted to stay
platform-neutral:

- `Catalogue` takes an optional `hour12?: boolean` instead of reading
  `expo-localization` itself; the app works out the clock preference where
  it renders `Catalogue` (`const clock = getCalendars()[0]?.uses24hourClock;
  hour12 = clock == null ? undefined : !clock`) and passes it in. Web has no
  12/24-hour API and reports none, so the locale default still applies there.
- `Receipt` takes `store: { name, address? }` instead of the app's Medusa
  settings, an optional `topInset?: number` instead of reading
  `StripHeightContext` itself, an optional `formatDate?: (iso) => string`
  instead of the app's `lib/format-date`, and `taxLabel` (as `Cart` already
  did, TV6a) instead of a hard-coded "VAT n%".
- `injectPrintStyle`'s `dataSet` augmentation moves with it into the
  package's own `uniwind-env.d.ts` (TV6a's note in ADR-065's predecessor);
  the app's own augmentation is no longer needed.

## Decision

- The app imports `Catalogue`, `Receipt`, `injectPrintStyle`, `SyncStatus`
  and `formatStockSyncTime` from `@tallyui/components` instead of keeping
  its own copies. `components/catalogue.tsx`, `receipt.tsx`,
  `sync-status.tsx` and `print-style.ts` are deleted.
- `app/index.tsx` computes `hour12` next to where it renders `Catalogue`
  and passes it in; it maps its store settings to `Receipt`'s `store` prop,
  reads `StripHeightContext` itself for `topInset`, and passes
  `lib/format-date`'s `formatDate` and
  `taxLabel={(ppm) => \`VAT ${ppm / 10000}%\`}` so the receipt keeps reading
  the same dates and "VAT 25%"/"incl. VAT 25%" rows.
- The app's own `dataSet` augmentation (`components/print-style.ts`) is
  removed outright: `tsc` still passes without it, since
  `@tallyui/components`'s own `uniwind-env.d.ts` augmentation reaches the
  app's compilation through its `tsconfig.json` path mapping
  (`@tallyui/components` → the package's `src/index.ts`, which references
  it).
- The screen tests are unchanged apart from their imports and props.
  `tests/catalogue.test.tsx`'s clock-preference test stays app-side (the
  conversion is the app's now): it mirrors `app/index.tsx`'s own `hour12`
  computation and passes the result into `Catalogue` directly, with
  unchanged assertions.
- Vitest config fix (front desk): the app's screen tests previously
  imported TallyUI components by internal `node_modules` path and mocked
  `src/cart`/`src/checkout` the same way, because spreading the
  `@tallyui/components` barrel with `importOriginal()` failed under vitest
  (`SyntaxError: Unexpected token 'typeof'` — vitest externalized the
  package, so the app's `react-native` → `react-native-web` alias never
  applied and the native, Flow-typed `react-native` entry loaded).
  `vitest.config.ts` now sets `test.server.deps.inline: [/@tallyui\//]`, so
  every `@tallyui/*` module goes through the same alias and transform
  pipeline as the rest of the app; `vi.mock('@tallyui/components', ...)` now
  uses `importOriginal()` and keeps the real `Cart`/`Tender`/`Catalogue`/
  `Receipt`. The primitives those real components compose internally
  (`../cart`, `../checkout`, `../product`, `../input`, `../ui` — not the
  barrel) are mocked at those module ids, aliased in `vitest.config.ts` to
  their package source, rather than by a literal `node_modules` path.
- The app keeps only screens and wiring. Fixes to the catalogue, receipt,
  print style or sync status go to TallyUI, not here.

## Consequences

- No behaviour, figure, label or layout change; this is an import move plus
  the `hour12`, `store`, `topInset`, `formatDate` and `taxLabel` props the
  app already computed or hard-coded before.
- The screen tests no longer need a `node_modules`-path workaround to reach
  TallyUI's real sale/catalogue components under vitest.
