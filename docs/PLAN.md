# Medusa POS product plan

*Started 2026-10-06 by the Mac mini medusapos worker. When the product lane resumed after the live MVP demo, no plan
file existed, so this one was rebuilt from the open issues, `docs/backlog.md` and a visitor walkthrough of
demo.medusapos.com (`~/agent/handoff/medusapos-demo-walkthrough-2026-10-06.md`). Newest status first in each
milestone. Marketing-site work is not tracked here.*

## Where we are

The MVP is live:
- https://demo.medusapos.com/demo signs a visitor in with one click;
- the demo backend is https://demo-api.medusapos.com;
- the app pins TallyUI 3.0.0.

A visitor can:
- open a register;
- sell from 1,956 products with cash or an external card, offline too;
- apply line and order discounts;
- close the register with a count;
- see each sale reach Medusa once.

Paul, 2026-10-05: "a good start, but there's still a lot of work to do".

## How the lane runs

- **One small spec at a time.** Specs live in `~/agent/handoff/spec-*.md`; the route-implementation flag decides
  Codex or the Opus pool.
- **Review:** the worker reviews, reruns the acceptance commands and applies the named mutations itself.
- **Merge:** on green CI and the worker's own review.
- **Demo:** the demo backend is redeployed by the front desk. After a plugin change merges, ask for it with an fd-note.

## Milestone 1: contract parity with TallyUI 3.0.0 (done 2026-10-06)

| Item | Status |
|---|---|
| #147 `order.create` v4: net line discounts, `/info` advertises 4, and the till's outbox sends at the store's version | merged #183 (7b5d9bb); the demo has advertised v4 since the e5f94df redeploy |
| #129 name "the Medusa POS plugin" in the sync status | merged #184 (405db4f) |
| #125 flaky D3 store-settings test | merged #185 (6e23f36) |

## Milestone 2: what a demo visitor sees (this repo's share)

From the 2026-10-06 walkthrough (`~/agent/handoff/medusapos-demo-walkthrough-2026-10-06.md`), worst first.

| Item | Status |
|---|---|
| Tile prices leave out VAT (€24.99 tile, €31.24 cart) | merged #187 (e5f94df) and #191 (b3a4e5b). Medusa uses a region preference only for prices with a region rule, so the demo needed the EUR currency preference too. Live once the front desk redeploys b3a4e5b, reruns `seed-demo-presentation.js` and re-snapshots the golden |
| The receipt header says "Default Store" | merged #187; live since the e5f94df redeploy ("Medusa POS demo store") |
| A 14.7 s first sync, with "No products yet." for 5 s | measured (`~/agent/handoff/medusapos-sync-perf-2026-10-06.md`): the app's share is about 30 ms, 68% is demo-server time and 21% sequential price calls. The fixes are TallyUI connector-medusa work plus demo sizing (front desk); "No products yet." is TallyUI's `Catalogue` (Milestone 3) |
| Settings has two back controls | merged #189 (d33e6d2) |
| "Send feedback" leaves the app in the same tab | merged #188 (b67e0c5) |
| The first tile is out of stock after other visitors' sales | the nightly reset covers it; consider resetting more often than nightly |

## Milestone 3: what a demo visitor sees (TallyUI's share, reported to the front desk)

Written up for the TallyUI lane in `~/agent/handoff/tallyui-component-bugs-2026-10-06.md`:

- The register panel can't be dismissed on web, which blocks Sign out, Orders and Settings.
- The receipt shows the order discount twice.
- The cart's empty state has no left padding.
- Orders has no detail view.
- The receipt numbers a sale "340537-1", and Orders shows the same sale as "#303".
- The catalogue says "No products yet." while the first sync runs.
- connector-medusa: first-sync speed (parallel price calls, page size 250, a lighter product query), and
  `pricesIncludeTax` read from the region preference where Medusa's per-price rule uses the currency's.

## Milestone 4: registers, after the TallyUI rulings

- #174 item 1: take over a register that is open on another device (waits on TallyUI/tallyui#371's contract).
  **Now visitor-facing on the demo:** every visitor after the first who opens Register 1 gets
  `register_session_already_open`, and the till hides it (`~/agent/handoff/medusapos-demo-check-2026-10-06.md`).
- #174 item 4: one shared "Sign in again" strip (TallyUI/tallyui#373, adopted at the next pin).
- #123: list a session's rejected sales in the register view (needs a cross-repo ruling).

## Milestone 5: release

- #128: the RxDB 17.5 release gate and the no-rollback rule are in `docs/release-checklist.md`. The carry-over test
  covers web; native and Paul's go-ahead on TallyUI#242 are still open.
- Publish `@medusapos/medusa-plugin` to npm with trusted publishing (`docs/backlog.md`). It needs Paul's `@medusapos` npm
  scope.

## Smaller backlog (`docs/backlog.md`)

- Done 2026-10-06: keep the till's email when a found customer is attached (#190, c0b76f5); a token refresh no longer
  restarts catalogue sync, now pinned by a test (#192, a697c4b).
- Open: screen tests stub TallyUI primitives through deep aliases.
- Design question: `insufficient_stock.quantity` is the level's whole shortfall (ADR 0003), so selling 1 when stock
  already stood at −1 reports 2. Decide whether the cashier should see "units sold without stock" instead.
