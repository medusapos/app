# Changelog

## 0.2.3 — 2026-10-07

- **Added:** POS access for Medusa RBAC (ADR 0023, part 1, medusapos/app#253). The `tally_pos:use` and `tally_pos:approve_variance` policies; with RBAC on, every `/tally/v1` route requires `tally_pos:use`. With RBAC off, every admin may use the POS, as before.
- **Added:** the `tally-pos-roles` exec script creates or updates the "POS cashier" and "POS manager" roles; it is safe to run again.

## 0.2.2 — 2026-10-07

- **Fixed:** a command on a session that was taken over is refused `register_session_superseded` (with the take-over data) when that session was opened at register contract 2, whatever the command's own contract; a session opened at contract 1 still gets `register_session_closed`. Needs the new migration (`npx medusa db:migrate`).

## 0.2.0 — 2026-10-06

- **Breaking (meaning):** `insufficient_stock.quantity` changes from the level's whole shortfall in variant units to the units of this sale that stock did not cover: min(units sold, shortfall in variant units). Selling 1 unit when stock is −1 now reports 1 instead of 2. The warning shape is unchanged.
- **Added:** `session.rejected` on `GET /tally/v1/registers/{id}` (medusapos/app#230), present only when non-zero; absent means zero.
