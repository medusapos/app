# Live variant chooser

Status: Accepted
Date: 2026-09-25

## Context

The variant chooser is the app's only per-variant stock display. It showed
the variant entries copied when the tile was pressed, but took its "as of"
time from live props. When a stock reconcile pass (ADR-060) landed while the
chooser was open, the chooser kept the old status beside a fresh time.

Evidence: in the PR #63 CI trace, the reconcile's one
`GET /admin/inventory-items` returned 0 for both E2E-4B and E2E-1, but the
open chooser, holding a copy, kept "In Stock" beside a fresh "as of" time.

## Decision

The chooser is live. Its state holds only the chosen product's id (or
nothing), and every render derives the choices from the current catalogue
entries. Stock snapshots are never held in UI state.

- A product that leaves the catalogue (a resync, or no longer sellable)
  closes its chooser.
- Selecting a variant uses the current entry.

## Consequences

- An open chooser follows every reconcile pass and catalogue sync without a
  reopen, and its status and "as of" come from the same render.
- A variant's status can change under the cashier's finger; the sale still
  goes through, since stock warnings are handled server-side (ADR 0003).
- `e2e/live-stock.spec.ts` waits for the pass's tile render before it reads
  the chooser, retries with a short inner timeout, and has a regression test
  that delays `/admin/inventory-items` 750 ms under an open chooser.
