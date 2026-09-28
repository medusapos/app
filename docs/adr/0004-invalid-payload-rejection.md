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
  - Today those checks are the missing sales channel, the missing stock location or address, and the missing shipping option.
  - A later change adds the shipping-profile check before the workflow runs.
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

**Decision.** Before any write, the plugin reads the shipping profiles of the sale's products (a product without a profile doesn't count):
- **One profile:** the automatic pick takes the earliest option at the location on that profile. An explicit `shippingOptionId` must use that profile.
- **No matching option,** or an explicit option on another profile: a `store_configuration` rejection naming the ids.
- **Several profiles:** a `store_configuration` rejection naming the profiles.

**Consequences.**
- Multi-profile carts, which would need one shipping method and fulfillment per profile, are out of scope for the MVP. Stores sell each profile's products in separate sales, or put POS products on one profile.
- The rejection is raised before any write, so it follows this ADR's store-configuration rule: not stored, and it applies once the store is fixed.
