# Offline sale stock and order recovery

Status: Accepted
Date: 2026-09-23

## Context

An offline sale that happened must never be lost. Medusa refuses orders and
reservations when stock is short.

## Decision

Check availability only at the sale's stock location. Raise each level by its
shortfall before the draft and lower it by the same amount after fulfillment;
both changes are compensated. Stock ends at original minus sold and may be
negative. Return one `insufficient_stock` warning per short variant, with its
shortfall in variant units.

Record top-ups in draft metadata and mark their take-back as reversed. Dedupe
trusts only completed orders; resume a half-made order's missing steps in recipe
order, each as its own workflow run. Never cancel it: cancelling a fulfillment
re-reserves stock and fails when stock is short.

Two residual windows remain, each milliseconds wide and each needing a
process crash (not an error, which compensates):

- Between the top-up step and draft creation: the top-up is unrecorded, so
  stock stays too high by the shortfall. Recording the top-up in the draft
  first is impossible with the verified recipe, because Medusa confirms
  inventory both when it creates a draft order (`createOrderWorkflow`) and
  when it adds items to one (`addDraftOrderItemsWorkflow`), so no draft with
  a short sale's items can exist before the top-up.
- Inside the take-back, between the stock adjustment and the
  `tally_stock_topups_reversed` flag: the inventory and order modules share
  no transaction, so a resume would take the stock back a second time
  (stock too low by the shortfall).

Both are narrowed by the amendment below (2026-09-24).

A stock refusal from Medusa during the workflow is now a race (another
register sold the same item between our stock read and the reservation),
so it is rethrown as a transient failure and the retry recomputes the
top-up; it is never a final rejection.

Also post-MVP (from the #12 review, not blocking):

- ~~Write the take-back and its reversed flag atomically (see the second
  window above).~~ Resolved 2026-09-24 by the amendment below.
- ~~A payment collection left `authorized` (not `completed`) by a crash
  makes resume fail on every retry.~~ Resolved 2026-09-24: resume marks a
  `not_paid` collection as paid and, for any other unfinished collection,
  authorises pending sessions and captures every uncaptured payment. It
  captures rather than cancels because the sale was paid at the till.
- Each in-flight sale holds one pooled Postgres connection for its advisory
  lock, so concurrent sales are bounded by the pool size.

## Amendment 2026-09-24: the two crash windows

Decided by the front desk after review: record the top-up on the command's
`tally_command` ledger row, which exists before the top-up. The item-less
draft and draft-edit flow was rejected: it replaces the verified order
recipe and does nothing for the take-back window.

Rule for every ambiguous crash: **stock may end too high, never too low.**
A top-up whose outcome is unknown is assumed not applied, and a take-back
whose outcome is unknown is assumed done, so stock is never taken back
twice. Stock that is too high is an ordinary stock count to correct; stock
taken back twice hides a real shortfall.

Window 1, top-up before the draft:

- Two nullable jsonb columns on `tally_command`: `stock_topups_pending`
  (the top-up about to be applied) and `stock_topups_applied` (top-ups
  confirmed applied by an earlier attempt that crashed before its draft
  existed). Both hold `{ inventory_item_id, location_id, shortfall }` lists.
- The workflow writes the pending top-up to the ledger row, applies it, then
  moves it to applied and clears pending. Each write is guarded by the
  claim token and compensated on error.
- A retry of the same command reclaims the row and carries the applied
  top-ups forward. It plans the new shortfall from live stock, which
  already includes the earlier top-up, and records the sum per inventory
  item in the draft's `tally_stock_topups`, so the take-back and the
  `insufficient_stock` warning cover both.
- A pending top-up without applied on a retry is the ambiguous case: it is
  assumed not applied and ignored. Stock is then too high by that
  shortfall at worst, as before this amendment. The pending list stays on
  the row as a record only if the retry needs no new top-up; a retry with
  its own shortfall overwrites it with its own intent.
- Compensation restores the ledger lists by command id while the row is
  `in_progress`, without the claim-token check the forward writes use.
  Otherwise an attempt that overran its lease would find its token
  replaced, skip the restore, and leave a top-up listed as applied after
  Medusa's own compensation had already taken it out of stock; the next
  retry would carry it and stock would be taken back twice. This is safe
  because the advisory lock on the sale's client order ID means only the
  compensating attempt can be running for that sale.
- A failed attempt used to delete its ledger row on release. A row with
  applied top-ups is now kept on release and made reclaimable at once,
  so a transient failure does not lose them.
- A carried top-up is lost only if the retry is then rejected (for example,
  the region was removed meanwhile): stock stays too high by it.

Window 2, the take-back:

- The take-back writes `tally_stock_take_back_started: true` to the order's
  metadata before it adjusts stock, then sets `tally_stock_topups_reversed`.
- A resume that finds the take-back started but not reversed skips the
  adjustment and only sets the flag. Stock is too high by the shortfall if
  the crash came before the adjustment, and never taken back twice.
- Every await after the take-back's adjustment commits is covered
  (2026-09-29): a failed lock release is logged and the step succeeds; a
  failed `tally_stock_topups_reversed` write is logged and returns
  `StepResponse.permanentFailure` with the success compensation data, so
  Medusa puts the stock back exactly once and a retry takes it back again.
  The compensation reads the order's metadata and checks its marker under
  the stock lock, and writes its restore together with
  `tally_stock_take_back_compensated` (this run's attempt id) right after
  its re-adjustment under the same lock, so a rerun never re-adjusts and the
  restore never overwrites metadata written while it waited. A throw after
  its first write (the re-adjustment, or the restore when it has nothing to
  re-adjust) is logged, not rethrown, so the compensations after it (the
  top-up reversal, the order cancel) still run.
  A failed write after the compensation's re-adjustment leaves `started`
  or `reversed` set. Where the order survives (resume, reject), a retry
  then skips the take-back and the stock ends too high by the shortfall,
  with only a log line: the same direction as the rule above (stock may end
  too high, never too low). In `order.create` the order cancel and the
  top-up reversal still run, so stock ends exact.
- **Fulfilment compensation (fixed 2026-09-29):** our two fulfilment steps
  were `createOrderFulfillmentWorkflow.runAsStep(...)` renamed with
  `.config({ name })` inside `when`. In Medusa 2.21 that loses their
  compensation: `refRet.config` builds a handler for the new name
  (`workflows-sdk/dist/utils/composer/create-step.js:69`), but
  `when().then()` calls `step.if()` (`when.js`), which re-registers the
  pre-rename handler under the new name (`create-step.js:90-99`). Its
  compensation looks up the step's output under the old name
  (`create-step-handler.js`), finds none, and `runAsStep`'s compensation
  (`create-workflow.js:195-224`) cancels by transaction id, which throws
  "could not be found" (`transaction-orchestrator.js:1150`) because the
  fulfilment workflow is never stored. So a failed `order.create` never
  reversed a fulfilment's stock write. The fix wraps each group in its own
  workflow (`tally-fulfill-first-group`, `tally-fulfill-second-group`),
  called without a rename. Rule: never rename a step inside `when`.

Also from the #22 review: resume skips a `canceled` or `failed` payment
collection instead of trying to capture it, and when no other collection
is left it creates a new one, as it does for an order with none, because
the sale was paid at the till.

## Amendment 2026-09-29: Forward, state-driven resume is the compensation mechanism

Cross-pollination note for WCPOS v2's design (from TallyUI ADR-038's `platform_error` amendment).

Medusa's recipe resumes a half-made order instead of rolling it back. Payment is marked paid
because the money is already at the till, so there is nothing to refund. Every step reads the
order's state and does only what is missing, so it is idempotent given the state it reads. A
fully compensated (canceled) order is ignored by the dedupe lookup, and the retry starts afresh.

Vendure's case differs: its ErrorResults are deterministic for the same command and state, so a
platform refusal is stored as a `platform_error` rejection and replays as recorded. A Medusa
resume failure is a thrown error (a race, a lock, a restart) and stays transient.

Forward resume is safe only for states the recipe creates. Resume accepts a completed order,
`not_paid`, `completed`, `canceled` and `failed` collections, and `authorized` or `awaiting`
ones only when every session and payment uses `pp_system_default` (the provider
`markPaymentCollectionAsPaid` uses). Any other collection status, any other provider, or a
canceled fulfilment means an admin acted on the order. Resume then throws before any write,
and the ledger row becomes `needs_admin`, which the reclaim never matches; the till gets
`409 in_progress`. The `tally-ledger-resolve` exec script either reopens the row for a resume
(`apply`) or cancels the sale's live order and then stores a `platform_error` rejection with
`platformCode: 'TALLY_ADMIN_REJECTED'` (`reject`). A cancel Medusa refuses leaves the row `needs_admin`,
so a rejected command never has a live order.

A new command id for an existing live `clientOrderId` follows the original command's ledger state:
an applied result is copied with its stored warnings and the new id, and stored for duplicate replays;
a superseded original copies its successor only when that successor is applied, otherwise the answer is transient.
A fresh `in_progress` lease or `needs_admin` row answers 503 without storing the new command; a stale lease
is taken over and the order resumes under the new command (a lost takeover answers 409). After completion,
the original is marked `superseded` by the new command and resends return its result as a duplicate.
A rejected original with a live order answers 503 and logs an error; a missing ledger row resumes as an orphan.
A takeover resumes the original's order with the new command's payload (its `totalMinor` and lines), as orphan
recovery does, so its warnings come from that payload; only a copy keeps the original's recorded warnings.
The takeover refreshes the original's lease, so if the new command then fails transiently, the next colliding
command answers 503 rather than taking over until that lease expires (`CLAIM_LEASE_SECONDS`, 120 s); this heals itself.
The live-order lookup skips canceled orders, so after an admin reject (which cancels the order) a retry under a new command id is a new sale; Medusa has no unique constraint on `metadata.tally_client_id`, so no id has to be released.

An applied id always answers its recorded result before any check that could refuse it; orders applied before a check existed are never refused on resend.
Version rules govern new work only: `unsupported_version` comes after the replay read, so an applied id resent at its recorded version, even one no longer supported, answers its recorded result (a different version changes the fingerprint and answers `idempotency_mismatch`).

## Consequences

Negative stock is visible to the merchant. A sales channel with several stock
locations may reserve at another location than the sale's.
