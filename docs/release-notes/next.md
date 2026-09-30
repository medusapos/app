# Medusa POS, next release (draft)

A running draft for the next release. At release time, rename it to `v<version>.md` and fill in the version and date. The [release checklist](../release-checklist.md) comes first.

## Before this release can ship

- **RxDB 17.5 gate:** if this release moves the app to TallyUI's RxDB 17.5 packages, it waits for TallyUI/tallyui#242, which must prove the storage upgrade on browser OPFS, iOS and Android. It also carries the carry-over test for every app-owned collection (issue #128).
- **No rollback across it:** once a till has run the RxDB 17.5 build, never roll it back to an older build; that till would show no orders. Fixes go forward.

## Plugin changes since 0.1.0 (merged)

- **Stock safety:** a failed sale puts back its stock top-up, fulfilment and take-back exactly once (#116, #117).
- **clientOrderId collisions:** a new command id for a sale that already has an order follows the original command's ledger state (#118).
- **Replay first:** a recorded command answers its recorded result before any check that could refuse it (#120), with string length bounds and NUL refused.
- **Rejected sales:** a sale an admin rejects never counts in register figures (#121). A one-off backfill marks rejects made before that, as a dry run by default with a per-session report and undo (#127).
- **Stock location:** a sale's stock location must exist and belong to its sales channel (#130).
- **Oversized batches:** they answer 413 `batch_too_large` or `body_too_large` with the limit (#134).
