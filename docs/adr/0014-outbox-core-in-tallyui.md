# The outbox core, device id and orders list come from TallyUI

Status: Accepted
Date: 2026-09-27

## Context

The till's unsent-sales path lived in the app. `apps/expo/lib/use-outbox.ts`
opened the order store for the signed-in backend, ran TallyUI's
`createOrderOutbox` on it and watched the recent orders. `lib/register.ts`
minted and stored the register id. `lib/order-store.ts` held
`needsAttention`, and `app/orders.tsx` rendered the "Needs attention" and
"Recent" lists. TallyUI lifted all four into its packages (TallyUI ADR-052,
TV7, #142, pinned at `0eb3db8`):

- `@tallyui/pos`: `useOrderOutbox({ storeKey, open, transport, deviceId,
  onBusy?, onOpenError? })`, `getDeviceId(storage, key)` and
  `needsAttention(orders)`;
- `@tallyui/components`: `OrdersList({ orders, onRetry, formatDate?,
  footer? })`.

A wrong change here loses, duplicates or hides sales, so the lift was gated
on a point-by-point comparison before any app code was deleted. The
comparison covered the store-key guard, `record` throwing rather than
dropping a sale, the `flush`/`requeue` no-ops, closing a late open,
teardown, the 50 most recent orders, the busy flag, open errors, the device
id and `needsAttention`. All ten matched. The only structural difference is
that the transport is now built by a `transport(storeKey)` callback once per
open, instead of inline, and it still reads the token lazily.

## Decision

- `lib/outbox-context.tsx` wires `useOrderOutbox` in a small app hook,
  `useSessionOutbox(session, registerId)`:
  - `storeKey` is the session's `baseUrl`, and `open` is `openOrderStore`;
  - `transport` is `createHttpCommandTransport`, whose `getHeaders` reads
    the current token from a ref on every request, so a token refresh keeps
    the open store;
  - `onBusy` is `markBusy('outbox', …)`;
  - `onOpenError` calls `reportStorageStartFailure()` for a storage-worker
    failure.

  `OutboxProvider` and `useOutboxContext` keep their shape, so the screens
  are unchanged.
- The register id comes from `getDeviceId(defaultStorage(),
  REGISTER_ID_KEY)`. `REGISTER_ID_KEY` is `'medusapos.register_id'` and
  lives in `lib/session.ts`, so every existing till keeps its id. It sits
  there rather than in the outbox context because several screen tests mock
  that module.
- `app/orders.tsx` keeps the route, the `Stack.Screen` title and the session
  redirect. It renders `OrdersList` with the outbox's `recent`, `requeue` as
  `onRetry`, `lib/format-date` as `formatDate`, and the "Send feedback" link
  as `footer`.
- `lib/use-outbox.ts`, `lib/register.ts` (with `register.test.ts`) and
  `needsAttention` (with its test in `order-store.test.ts`) are deleted.
  TallyUI ported those tests (`device-id.test.ts`,
  `needs-attention.test.ts`). The app's outbox test
  (`tests/outbox.test.tsx`) and the screen tests stay as the end-to-end
  proof. Only their imports changed, and the outbox test now drives
  `useSessionOutbox`.
- The app keeps storage selection, `openOrderStore`, the legacy carry-over,
  the product cache and live-tab. Fixes to the outbox core, the device id,
  `needsAttention` or the orders list go to TallyUI, not here.

## Consequences

- No behaviour, label or layout change. The 360px screenshots of the Orders
  screen with one rejected and one "Waiting to sync" sale, taken with the
  clock pinned, are byte-identical before and after.
- The app no longer carries its own copy of the unsent-sales logic. A change
  to it arrives through a `TALLYUI_REF` bump, and the outbox, storage,
  offline and strips e2e specs are its regression proof here.
