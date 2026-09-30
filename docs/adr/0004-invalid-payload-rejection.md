# Invalid command payload rejection

Status: Accepted
Date: 2026-09-23

Amends TallyUI ADR-038.

## Context

A malformed payload with a valid command envelope was thrown inside the planner,
returned as `transient`, and retried forever by the register.

## Decision

Add the rejection code `invalid_payload`. Check payload shape before claiming
the command or locking its order. Check only types and presence, with finite
numbers; value rules remain in the planner. The message lists up to ten
validation errors. Do not store this deterministic rejection in the ledger;
replaying the same malformed payload returns the same rejection.

## Consequences

The register shows the sale under needs attention instead of retrying forever.
TallyUI's `CommandError.code` is a string, so no type change is required.
The TallyUI contract docs should list `invalid_payload`.

## Amendment: store-configuration rejections (2026-09-28)

**Context.** The hosted demo's sales never synced. Every `order.create` failed inside Medusa's `createOrderFulfillmentWorkflow` with "Shipping profile … does not match the shipping profile of the order item …". `executeOrderCreate` classified every error as `transient`, so the till retried the sale forever and showed it as "sending".

**Decision.** Add the rejection code `store_configuration`:
- **When it applies:** the plugin's own checks that run before any write throw a dedicated `StoreConfigurationError`, and `executeOrderCreate` turns that class, and only that class, into a per-command rejection whose message is the reason.
  - Those checks are the missing sales channel, the missing stock location or address, the missing shipping option, and the shipping-profile checks (next amendment).
  - A stock location named by `payload.locationId` or plugin option `locationId` must also exist and be assigned to the sale's sales channel; otherwise the refusal names its source (ruling 19, 2026-09-30).
  - When the sale resumes an existing order (a retry after a crash left a draft or a paid order), the same failures stay transient, because writes have already happened.
- **It isn't stored in the ledger:** the claim is released, as for `invalid_payload`. So the same command applies once the store is fixed, and the till's Retry works without a new command id.
- **Everything else stays `transient`,** including every error Medusa throws inside its workflows.

**Why the class, and not Medusa's error type.** Rejecting on Medusa's `INVALID_DATA` was considered and turned down:
- **Retryable races:** Medusa throws `INVALID_DATA` for races that a retry resolves:
  - a concurrent capture (`@medusajs/payment` `payment-module.js:387-395`);
  - fulfillment reservation mismatches after a resume (`core-flows` `create-fulfillment.js:160,170`);
  - "not a draft" on a concurrent draft conversion (`validate-draft-order.js:26`).
- **Stranded payment:** a rejection after the workflow has started can strand money. The workflow captures payment before it fulfils (`workflow.ts`), and Medusa's capture step has no refund compensation (`core-flows` `capture-payment.js:15-16`). A stored or final rejection at that point would leave a captured payment for a sale the till believes was refused.

Only errors raised before any write are safe to reject. **Don't widen this rule to Medusa's error types or messages.** A new permanent case gets its own pre-workflow check that throws `StoreConfigurationError`.

**Consequences.**
- The register shows such a sale under "needs attention" with the reason, instead of "sending" forever. After an admin fixes the store, Retry applies it.
- Stock top-ups carried from an earlier attempt stay applied when a later attempt is rejected, and stock stays too high by them. That's ADR 0003's accepted bias.
- A permanent failure inside Medusa's workflows still retries forever. Surfacing the reason in the till after repeated retries is a TallyUI outbox item.
- TallyUI's contract docs should list `store_configuration`.

## Amendment: one shipping profile per POS sale (2026-09-28)

**Context.** When plugin option `shippingOptionId` wasn't set, the plugin picked the earliest shipping option at the sale's stock location and ignored shipping profiles. Medusa's `createOrderFulfillmentWorkflow` refuses a shipped item whose product's profile differs from the option's (`core-flows` `create-fulfillment.js:78-83`). So any store with two profiles at one location could lose sales that way.

**Decision.** Before any write, the plugin reads the shipping profiles of the sale's products (a product without a profile isn't checked; see the backlog for the one case where Medusa still requires shipping for it):
- **One profile:** the automatic pick takes the earliest option at the location on that profile. An explicit `shippingOptionId` must use that profile.
- **No matching option,** or an explicit option on another profile: a `store_configuration` rejection naming the ids.
- **Several profiles:** a `store_configuration` rejection naming the profiles.

**Consequences.**
- Multi-profile carts, which would need one shipping method and fulfillment per profile, are out of scope for the MVP. Stores sell each profile's products in separate sales, or put POS products on one profile.
- For a new sale the rejection is raised before any write, so it follows this ADR's store-configuration rule: not stored, and it applies once the store is fixed. For a resumed order the same failure stays transient (previous amendment).

## Amendment: Step order and bounds (2026-09-29)

1. `validateBatch` validates the envelope, including refusing a NUL in the id.
2. A NUL-only payload check returns unstored `invalid_payload`.
3. The read-only replay read answers a recorded result.
4. Version rules answer `unsupported_version` or the existing version/field `invalid_payload`.
5. Type shape, length bounds and v3 fiscal checks return unstored `invalid_payload`.
6. The claim, sale lock, authoritative collision check and recipe are unchanged.

An applied id always answers its recorded result before any check that could refuse it, so orders applied before a check existed are never refused on resend. `invalid_payload` stays deterministic on the bytes and unstored.
The bounds and NUL rule match TallyUI's shared checks (`payloadBoundErrors` for the lengths, after the replay lookup; `payloadShapeErrors` for types and NUL). Lengths count UTF-16 code units on both sides, and the till's clamp stays within them without splitting a surrogate pair: `customer.email` is at most 254; `clientOrderId`, `createdAt`, `currency`, line `clientLineId`, `variantId`, `title`, payment `clientPaymentId`, `method`, `reference`, `registerId`, `cashierRef` and `locationId` are at most 255. The existing `customer.customerId` (64) and `sessionId` (36) bounds remain. All these string fields refuse U+0000 before replay.
A read-only collision pre-check before the claim is optional; the check under the lock is authoritative.
An `in_progress` row with a matching fingerprint falls through the replay read, so the new bounds apply to an
in-flight orphan too: a sale claimed before this change, whose payload breaks a new bound and whose worker died,
gets `invalid_payload` on resend and its half-made order is not resumed under that id. This is accepted: it needs a
row in flight across the deploy, and the till already bounds these fields.

## Amendment: Rejection classification (2026-09-29)

- `invalid_payload`: unstored, before the claim (shape, bounds, NUL, the version rules' `invalid_payload`, and the v3 fiscal checks).
- `unsupported_version`: after the replay read, never recorded.
- `store_configuration` and `unsupported_currency`: store-wide setup, unstored, with the claim released.
- `unknown_variant` (a variant that doesn't exist or is soft-deleted, a product that is soft-deleted, not `published`, or outside the sale's channel), `invalid_quantity`, and `underpaid`: per-sale facts, decided after the claim and stored. Soft-deleted variants and products were already `unknown_variant` before this amendment, because Medusa's query leaves them out (a product's soft delete cascades to its variants); the explicit `deleted_at` check is defensive. The new cases are unpublished products and products outside the channel. A stored `unknown_variant` is permanent: publishing the product later doesn't revive the sale.

A stored `unsupported_currency` rejected the sale forever even after the region was fixed, so it is now unstored. Rows stored before this change still replay as recorded, because the replay read answers any recorded result. The demo database is rebuilt nightly from a golden copy taken right after seeding, so it holds none. Any other store can find them with `select id from tally_command where result->'error'->>'code' = 'unsupported_currency'`, and remove them once the store is fixed, so that the till's resend applies.
