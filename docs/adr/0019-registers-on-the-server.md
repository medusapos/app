# Registers on the server (c2)

Status: Accepted
Date: 2026-09-28

## Context

TallyUI registers c2 syncs a till's register facts to the platform: sessions opened and closed, cash movements, and closures (the Z). They ride the existing `POST /tally/v1/commands` endpoint and its ledger (ADR 0001), as five new command types at version 1:
- `register.session.open`;
- `register.session.transition`;
- `register.movement.record`;
- `register.movement.void`;
- `register.closure.submit`.

**TallyUI ADR-068 is the cross-track contract:** the payloads (6a), the result shape (`result.register`), the refusal codes and the plugin checklist. The server must enforce the register rules itself, because two tills or two retries can race.

## Decision

A plugin module, `tally_register`, stores the facts in four tables:
- `tally_register`: the drawer, with its counters;
- `tally_register_session`;
- `tally_register_movement`;
- `tally_register_closure`.

Rows are never deleted or rewritten. The exceptions are a session's status fields, a voided movement's `voided_by`, and the register's counters.

**The rules are enforced in Postgres.** Each service operation is one transaction.
- **Constraints do what they can:**
  - one non-closed session per register: a partial unique index on `register_id` where `status <> 'closed'`;
  - one closure per session: unique `session_id`;
  - unique closure numbers per register: `(register_id, number)`;
  - one void per movement: a partial unique index on `voids`.
- **Row locks do the rest.** Every operation locks the session row first, then the register row, so there is one lock order and no deadlock. Under those locks:
  - the closure number must be `last_closure_number + 1`, so numbers are gap-free;
  - a movement or void is refused once the session's closure exists. A closure takes the session lock too, so no movement can commit after its closure.
- Perpetual totals are a floor and never lowered.
- Every `*_minor` column is `bigint`.

**Business refusals** are per-command `rejected` results in a 200, with `error.data`. The codes match TallyUI byte for byte:

| Code | When | `data` |
|---|---|---|
| `register_session_already_open` | a second non-closed session for a register | `sessionId` of the winner |
| `register_session_closed` | a movement or void on a closed session or one whose closure exists; a transition out of `closed` | none |
| `register_closure_exists` | a second closure (another id) for a session | `closureId` |
| `register_closure_number_invalid` | `number` isn't last + 1 | `counters` |

`register_approval_required` waits for c2c (P3).

**Two cross-track rules** (TallyUI ADR-068 is the contract both sides follow):
- **A transition is a state snapshot, not an edge.** A till can go counting → open → counting between reconciles, and only the latest state reaches the server.
  - Any transition from a non-closed session is accepted, and only a transition out of `closed` is refused.
  - A same-status transition is an applied no-op, and so is a snapshot older than the session's `status_at`: a stalled, re-executed command never overwrites a newer state.
  - The server never refuses a transition because it didn't see an intermediate state.
- **Movements are accepted on any non-closed session,** `open` or `counting`. They're refused with `register_session_closed` only when the session is `closed` or its closure has been submitted (TallyUI ADR-032).

**Operations are replay-safe by their till-minted ids.** Under the ledger's lease, a command whose write committed but whose ledger entry never completed (a crash) is re-executed with the same bytes. An existing session, movement, void or closure with the command's own id returns `ok` with the current state and writes nothing, and a transition to the status the session already has is a no-op `ok`. So a retry never turns a committed fact into a refusal, and it never writes the fact twice.

**The naming trap.** In medusapos, `order.create`'s `registerId` (order metadata `tally_register_id`) is the **till's device id** (ADR 0017). The register commands, the `tally_register` tables and `GET /tally/v1/registers/{id}` mean the **drawer**. They are never joined.

**Expected cash and the sales count** are derived on the server (P2):
- the sales count and sales come from orders whose `tally_session_id` is the session (order.create v3), using the till's own figures in `tally_pos_totals` (ADR 0012), never Medusa's recomputed totals;
- expected cash is those sales plus the counted float, plus paid-in, minus paid-out, with voids reversing their target. Per ADR-068 6a, `amountMinor` is always positive and `type` gives the direction; `no_sale` is 0;
- at `closure.submit`, the figures cover exactly the submitted `orderIds` and `movementIds`.

## Consequences

- Delivery comes in steps:
  - P1a: the module and its service;
  - P1b: routing the five types through the command endpoint, validators, `result.register`, `/info` `register: [1]`, and `parseCommandResult` accepting register results without `serverRefs`;
  - P2: derivation and `GET /tally/v1/registers/{id}`;
  - P3: approval.
- `approvedBy` is stored as the till sends it, and isn't verified until c2c.
- A `closure.submit` whose `registerId` isn't its session's drawer is `invalid_payload`. ADR-068 decision 8 (unknown register ids accepted as written) covers `session.open`, which creates the register.
- A refused register command stops that register's queue on the till (ADR-068 decision 4). So the server refuses only what the till can't produce, and never turns a retry into a refusal.
- Refunds stay 0 in c2.
