# A `/settings` route for per-till device settings

Status: Accepted
Date: 2026-09-27

## Context

The wedge listener's thresholds (`WEDGE_AVG_KEY_MS`, `WEDGE_MIN_CHARS`) were
constants in `apps/expo/lib/use-wedge-scan.ts`. WCPOS mirrors the first two as
per-store settings (`barcode_scanning_avg_time_input_threshold`,
`barcode_scanning_min_chars`); a Bluetooth scanner slower or a SKU scheme
shorter than the app's defaults needs a way to change them without a new
build. Register and printer settings are coming too, and none of them belong
on the sale screen.

A scanner is plugged into one till, not shared by every till a cashier might
sign into at that store: two tills at the same backend can carry a different
scanner and a different code scheme. The setting therefore keys on the
device, not the store.

## Decision

- A new `/settings` screen is the home for device settings, reached from a
  **Settings** header action next to Orders and Sign out. It follows the
  session redirect pattern of `app/orders.tsx`. Its structure stays plain — a
  screen of titled sections — so register and printer settings can be added
  as their own sections later; **Scanner** is the first.
- Device settings are stored per till, under the signed-in backend's
  `baseUrl`, the same way `lib/store-settings.ts` already keys its own
  per-backend caches (`medusapos.settings.` + baseUrl). The scanner's key is
  `medusapos.scanner.` + baseUrl (`lib/scanner-settings.ts`).
- **Minimum characters** applies on both paths that can read a scan: the
  phone-cart wedge listener (`use-wedge-scan.ts`) and, once TallyUI's
  `Catalogue` takes a `minCodeLength` prop (staged, not in this change), the
  Products search submit. Both are asked "is this code long enough to be a
  barcode rather than a stray keypress or an empty submit?" — the same
  question.
- **Average time per key** applies only to the wedge listener. The Products
  search box is a focused text field: a cashier can still type a SKU by hand
  and press Enter to look it up, so timing it out would break manual lookup.
  The wedge listener runs on an *unfocused* view, where nothing but a scanner
  (or someone typing unusually fast into nothing) produces fast, bursty
  keystrokes, so timing is what tells a scan from an accidental keypress
  there.
- `WEDGE_STALE_GAP_MS` (500 ms, the gap that starts a new buffer) stays a
  constant: no per-till scanner sends its keys with pauses long enough for
  this to matter, so there's nothing for a cashier to tune.

## Consequences

- The Settings screen's "Test scan here" field shares the wedge listener's
  own averaging function (`averageKeyMs`, exported from `use-wedge-scan.ts`),
  so a tester's read of "counts as a scan" always agrees with what scanning
  in the cart view will actually do.
- The Products path's `minCodeLength` wiring is staged: `app/index.tsx` leaves
  a `// TODO(scanner minCodeLength)` at the `Catalogue` call until TallyUI
  ships the prop and the pin bumps.
