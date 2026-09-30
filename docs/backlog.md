# App backlog

## A multi-variant product's tile price isn't deterministic

The tile shows one variant's price, but variant order isn't stable between
seeded runs (E2E product 4 reads €10 or €11 in the e2e screenshots). Tracked
in TallyUI's backlog: a multi-variant tile will show "from &lt;lowest
price&gt;" when variants differ, and connectors will return variants in a
stable order (by id). Nothing to fix in this app.

## A token refresh restarts catalogue sync

`useReplicatedProducts` (`apps/expo/lib/use-replicated-products.ts`) lists
`headers` in its effect's dependencies, so each token refresh tears the
effect down and starts it again: replication, the stock runner and the id
reconcile runner. The restart runs another id-reconcile start pass, which
costs one extra ids read a day. That's harmless, but it could be avoided by
reading the current headers through a ref instead of restarting on each
refresh.

## Screen tests stub TallyUI primitives through deep aliases

The screen tests use the real TallyUI components (`importOriginal()`), but stub
the primitives those components compose (`CartPanel`, `CartTotal`,
`CashTendered`, …) and assert against the stand-ins. To reach them,
`vitest.config.ts` aliases `@tallyui/components/{cart,checkout,product,input,ui}`
to TallyUI's internal submodules, so a TallyUI refactor of those folders breaks
the app's tests in one place. Moving the assertions onto the real primitives
(or TallyUI exporting those subpaths) would drop the aliases (from the TV6b
review).

## Hosted catalogue sync and search are too slow at 1,956 products

A Playwright trace of the hosted smoke (app.medusapos.com against the demo backend, both at 4a60da6, 2026-09-28) shows:
- the first catalogue sync takes **47 s** to reach "Up to date · 1,956 products";
- each product search or add-to-cart step afterwards takes **3–6 s**.

(That run's smoke failure was not the slowness: its sale never synced because the demo's seed put the E2E products on a different shipping profile from the shipping option the plugin picked, and the plugin retried the refusal forever; fixed in #93, #94 and the profile-aware pick.) The trace is kept at `~/agent/handoff/smoke-hosted-trace-2026-09-28.zip` (open with `npx playwright show-trace`). The profiling spike (2026-09-28) put the causes in TallyUI:
- an unvirtualized product grid: 8.7 s of the sync, and all of the 1.4–7.6 s search and add delay. TallyUI #191 virtualizes it, and it arrives with the next TallyUI minor. Re-measure then with the harness in `~/agent/handoff/perf-spike-harness`, including the tile count;
- sequential page fetches: about 15 s;
- SQLite/OPFS write amplification: 5.4 s after the grid fix;
- the background checks.

The findings are in `~/agent/handoff/perf-spike-findings-2026-09-28.md`. The app's own share is under 1 s: every sync page maps every product to a new object (`use-replicated-products.ts:113-116`) and rebuilds the sorted list (`index.tsx:221-226`). Throttle both during the first sync.

## Keep the till's email when a found customer is attached

When `order.create` v3 names a customer the plugin finds, the till's email is deliberately not passed, because Medusa's `findOrCreateCustomerStep` would swap in a guest customer. So the order takes the customer's stored email. If that customer has none, the order email is null and the email the cashier typed is kept nowhere (`packages/medusa-plugin/src/workflows/tally-order-create/plan.ts`). Record it as `tally_customer_email` metadata, and add a test for a found customer without an email (from the #90 delta review).

## Publish the plugin to npm with trusted publishing

v0.1.0 ships `@medusapos/medusa-plugin` as a tarball attached to the GitHub release. That's an MVP-week stopgap. From the next release, publish it to npm the way TallyUI does: a release workflow using npm trusted publishing (OIDC from GitHub Actions, with no long-lived token) and provenance. Testers then run `npm install @medusapos/medusa-plugin`.

It needs:
- an npm organisation or scope for `@medusapos`, which Paul creates;
- the package linked to this repository's workflow as a trusted publisher;
- QUICKSTART and the release note switched to install by name.
