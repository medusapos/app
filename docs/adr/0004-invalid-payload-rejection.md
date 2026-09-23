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
