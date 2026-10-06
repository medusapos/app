# Changelog

## 0.2.1 — 2026-10-06

- **Added:** an Install section in the README: install from npm, register the plugin, migrate.
- **Changed:** releases are published from GitHub Actions with npm provenance (trusted publishing); the package now carries its licence, changelog and repository links.

## 0.2.0 — 2026-10-06

- **Breaking (meaning):** `insufficient_stock.quantity` changes from the level's whole shortfall in variant units to the units of this sale that stock did not cover: min(units sold, shortfall in variant units). Selling 1 unit when stock is −1 now reports 1 instead of 2. The warning shape is unchanged.
- **Added:** `session.rejected` on `GET /tally/v1/registers/{id}` (medusapos/app#230), present only when non-zero; absent means zero.
