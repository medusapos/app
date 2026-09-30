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
- [ ] **Carry-over test:** the bump PR for TallyUI 3.0.0 carries one for every collection the app owns (`pos_orders`, `register_sessions`, `cash_movements`, `closures`, and the parked-sale drafts). The released build writes the documents, the new build opens the store, and whole documents are compared (issue #128).
- [ ] **The 3.0.0 bump and the pull notices (TallyUI/tallyui#261) ship in the same release, never apart** (Front desk ruling, 2026-09-30).
  - **Why together:** from 3.0.0, a product pull that fails with 401 no longer reaches the replication state's `error$`. A bump without the notice wiring would leave an expired till's products silently stale, and the till would never sign out. That is a regression.
  - **The wiring:** the app takes `@tallyui/*` only from published npm pins, so it lands with or right after the bump PR, and before the release is tagged. It needs two changes:
    - wire the replication state's `notice$` into SyncStatus's pull notice;
    - call `resume()` after a successful sign-in, so a pull stopped by an expired session starts again.
  - **Source:** the notices come from TallyUI/tallyui#259.
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
