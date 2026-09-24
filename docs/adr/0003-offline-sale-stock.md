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

Also from the #22 review: resume skips a `canceled` or `failed` payment
collection instead of trying to capture it, and when no other collection
is left it creates a new one, as it does for an order with none, because
the sale was paid at the till.

## Consequences

Negative stock is visible to the merchant. A sales channel with several stock
locations may reserve at another location than the sale's.
