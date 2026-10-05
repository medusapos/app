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

## Milestone 1: contract parity with TallyUI 3.0.0

| Item | Status |
|---|---|
| #147 `order.create` v4: net line discounts, `/info` advertises 4 | PR #183 (approved, auto-merge on green) |
| #129 name "the Medusa POS plugin" in the sync status | PR #184 |
| #125 flaky D3 store-settings test | PR #185 |

## Milestone 2: what a demo visitor sees (this repo's share)

From the 2026-10-06 walkthrough, worst first.

| Item | Owner |
|---|---|
| Tile prices leave out VAT: the tile reads €24.99, the cart €31.24. Decide the demo region's price preference (tax-inclusive for a European store) and fix the seed | this repo (`dev/`, `deploy/demo-backend`), plus a front-desk redeploy |
| The receipt header says "Default Store / Copenhagen"; the demo page says "Medusa POS demo store" | this repo (seed) |
| "No products yet." for about 4 s, then a 14.5 s first sync with the tiles reshuffling | measure first; the app's share is in `docs/backlog.md` |
| Settings has two back controls ("←" and "‹ Products") | this repo (`apps/expo/app/settings.tsx`) |
| "Send feedback" leaves the app in the same tab | this repo (`login.tsx`, the Orders footer) |
| The first tile is out of stock after other visitors' sales | the demo's nightly reset covers it; consider a reset more often than nightly |

## Milestone 3: what a demo visitor sees (TallyUI's share, reported to the front desk)

Written up for the TallyUI lane in `~/agent/handoff/tallyui-component-bugs-2026-10-06.md`:

- The register panel can't be dismissed on web, which blocks Sign out, Orders and Settings.
- The receipt shows the order discount twice.
- The cart's empty state has no left padding.
- Orders has no detail view.
- The receipt numbers a sale "340537-1", and Orders shows the same sale as "#303".

## Milestone 4: registers, after the TallyUI rulings

- #174 item 1: take over a register that is open on another device (waits on TallyUI/tallyui#371's contract).
- #174 item 4: one shared "Sign in again" strip (TallyUI/tallyui#373, adopted at the next pin).
- #123: list a session's rejected sales in the register view (needs a cross-repo ruling).

## Milestone 5: release

- #128: the RxDB 17.5 release gate and the no-rollback rule in the release checklist.
- Publish `@medusapos/medusa-plugin` to npm with trusted publishing (`docs/backlog.md`). It needs Paul's `@medusapos` npm
  scope.

## Smaller backlog (`docs/backlog.md`)

- Keep the till's email when a found customer is attached.
- A token refresh restarts catalogue sync.
- Screen tests stub TallyUI primitives through deep aliases.
