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

Post-MVP: close both by creating an item-less draft first, recording the
top-up as pending, and adding items through Medusa's draft-edit flow with
price overrides; or by recording the intended top-up in the ledger row,
which exists before the top-up.

A stock refusal from Medusa during the workflow is now a race (another
register sold the same item between our stock read and the reservation),
so it is rethrown as a transient failure and the retry recomputes the
top-up; it is never a final rejection.

Also post-MVP (from the #12 review, not blocking):

- Write the take-back and its reversed flag atomically (see the second
  window above).
- ~~A payment collection left `authorized` (not `completed`) by a crash
  makes resume fail on every retry.~~ Resolved 2026-09-24: resume marks a
  `not_paid` collection as paid and, for any other unfinished collection,
  authorises pending sessions and captures every uncaptured payment. It
  captures rather than cancels because the sale was paid at the till.
- Each in-flight sale holds one pooled Postgres connection for its advisory
  lock, so concurrent sales are bounded by the pool size.

## Consequences

Negative stock is visible to the merchant. A sales channel with several stock
locations may reserve at another location than the sale's.
