# Release checklist

Work through this before tagging a release of the app or the plugin. An item that doesn't apply to a release is marked "n/a" with a reason in the release PR, never skipped silently.

## Gates

- [ ] **TallyUI 3.0.0 (RxDB 17.5.0 storage).** The app's next release moves to `@tallyui/*` 3.0.0, which is built on `rxdb` 17.5.0 (TallyUI #223). Nothing is tagged and nothing is published until **both** of these hold:
  1. TallyUI/tallyui#242 has proven the storage upgrade on browser OPFS, iOS and Android;
  2. Paul has given the go-ahead on #242.

  **Scope of this gate:** it holds back the next app release, and any plugin release shipped with it. A plugin-only release that doesn't change the app may go first only if Paul says so in the release PR.
- [ ] **No rollback across TallyUI 3.0.0.** The storage upgrade is one-way.
  - Once a till has opened the new storage, an older build shows none of its orders and sends none of its waiting sales, until the till is updated again.
  - A sale that seems to have vanished must never be rung again: it comes back after the update and would count twice.
  - Fixes go forward, never back.
  - The release notes for the store owner say this in plain words (see `release-notes/next.md`).
- [ ] **Carry-over test** (Front desk rulings, 2026-09-30): the bump PR carries the test and does not merge without it passing. The released build writes documents, the new build opens the same store, and whole documents are compared (issue #128).
  - Covers exactly the four app-owned collections (`pos_orders`, `register_sessions`, `cash_movements`, `closures`) plus the `register` local document, with an exact collection-set check. There is no parked-sale drafts collection: TallyUI's `draftsCollection` is never supplied.
  - Web (OPFS) only; native is n/a while its storage is memory (`apps/expo/lib/product-cache.ts:27-30`).
  - Confirm the tag the carry-over test resolved (logged by the run): `e2e/carryover/released-tag.mjs` resolves the newest `v*` tag on main; no constant is edited as a release step.
- [ ] **The 3.0.0 bump, the pull notices (TallyUI/tallyui#261) and the connector factory (TallyUI/tallyui#307) ship in one PR, never apart** (Front desk ruling, 2026-09-30).
  - **Why together:** from 3.0.0, a product pull that fails with 401 no longer reaches the replication state's `error$`. Today the app signs the till out from that `error$` path (`apps/expo/lib/use-replicated-products.ts`). A bump without the notice wiring would leave an expired till's products silently stale, and the product pull would no longer sign the till out. That is a regression. A 401 on a sale send is the outbox's, and is unaffected.
  - **The wiring:** the app takes `@tallyui/*` only from published npm pins. The wiring goes in the bump PR itself: a bump PR without it does not merge. It needs three changes:
    - wire the replication state's `notice$` into SyncStatus's pull notice;
    - on an `unauthorized` notice, call the existing `onUnauthorized()`, so the till signs out the same way the old 401 did (Front desk ruling, 2026-09-30);
    - call `resume()` after a successful sign-in, so a pull stopped by an expired session starts again.
  - **Source:** the notices come from TallyUI/tallyui#259.
  - **The connector factory (TallyUI/tallyui#307, fix in PR #315: open, not merged; a gate before 3.0.0), also in the same bump PR:**
    - **Why:** the Medusa connector's reconcile feed is a module-level singleton. After a store switch in one runtime (sign out of A, sign into B), A's queued tombstones and refetches reach B's collection.
    - **The change:** as proposed in #315, TallyUI adds factories that each return a connector with its own feed: `createMedusaConnector()`, and `createMedusaAdminUserConnector()`, which is the one medusapos needs in place of `medusaAdminUserConnector`. The bump builds one anew on each sign-in or store change: one instance per store session.
    - **Today:** the app holds one module-level connector: `apps/expo/lib/pos-connector.ts:3` (`posConnector = medusaAdminUserConnector`), used at `apps/expo/app/index.tsx:33` and `lib/session.ts:51`, with `medusaConnector.id` at `lib/session-context.tsx:42`.
    - **The old exports:** #315 deprecates the static `medusaConnector` and `medusaAdminUserConnector` exports, with a dev warning when one feed serves two replications; they go in 4.0.
    - **At the bump:** re-check the API as #315 merged it.
    - **The rule:** the bump, the pull notices and the factory ship in one PR, never apart.
- [ ] **Storage start failures (TallyUI/tallyui#304, from #293), in the bump PR.**
  - **What changes:** in `@tallyui/storage-sqlite` 3.0.0, a Safari private window is a `StorageUnavailableError`, and `isStorageWorkerStartError` is false for it. So the app's calls to `@tallyui/database`'s `isStorageWorkerFailure` no longer catch it (`apps/expo/lib/outbox-context.tsx:26`, `apps/expo/lib/use-replicated-products.ts:241`).
  - **What the bump does:** it adopts the storage-sqlite README's three-way switch ("Recognising a failed start") with these exact texts:
    - `isStorageUnavailableError` → "This till can't save sales in a private window." with the detail "Open it in a normal Safari window (or another browser) and sign in again. Nothing has been lost: no sale was taken here."
    - `isStorageHeldError` → "This till is already open in another tab. Close the other tab, then reload this one."
    - `isRxdbRemoteVersionMismatch` (`@tallyui/core`) → "This till needs a quick reload to finish updating. Reload the page."
    - anything else → the app's generic storage failure, as today.
- [ ] **Two price runners on one collection (found in the review of TallyUI/tallyui#284, still open):**
  - **The problem:** `apps/expo/lib/use-replicated-products.ts` starts two `startFingerprintReconcile` runners on `db.products`: the calculated-price runner (`:188`), then the base-price runner (`:202`). Both use the default `stateId`. **If #284 ships as reviewed**, they share one persisted gate, and the second keeps its gate in memory and runs about an hour after every start.
  - **The fix lands in the bump PR for the first `@tallyui/*` version that carries #284:** pass `stateId: 'calculated-prices'` to the calculated-price runner (`:188`), as #284's docs example does. The base-price runner keeps the default. Re-check #284's final docs then.
  - **Also check the interval:** under #284 as reviewed, an `intervalMs` under an hour becomes hourly. So the calculated-price runner's 30-minute re-check would slow, and a price list starting or ending could reach the till up to about 2 hours late. If #284 keeps that, the bump PR either restores the 30-minute re-check or says the delay is accepted.
  - **Why it waits:** 2.0.0's `startFingerprintReconcile` has no `stateId` option.

## Every release

- [ ] CI is green on the release commit: every check, including the Medusa plugin job (with the seeded backfill run), Typecheck and unit tests, Dev store unit tests, Web export, End-to-end (web) and the demo backend image.
- [ ] The release notes (`docs/release-notes/v<version>.md`, renamed from `next.md`) say what changes for the store owner, and every gate above that applies.
- [ ] Plugin: `npm run build` from `packages/medusa-plugin`, and check the package contents (`.medusa/server` only).
- [ ] Any change to the command contract (codes, limits, fields) matches the TallyUI core version the app pins, and says which `@tallyui/*` version the app needs.
