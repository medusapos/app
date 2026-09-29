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
- **Order, not clocks** (the Front desk and TallyUI ruling of 2026-09-28, TallyUI #188 round 3; it supersedes the earlier ADR-068 5a wording that ignored "a transition older than the status time"). The server applies a register's commands in the order it receives them: batches apply in array order, and the till sends one register's commands serially, in its ledger order, stopping at the first one not applied. `at` and `createdAt` are facts carried in the payload, never ordering keys. A till's clock can be corrected, and comparing timestamps would drop a legitimate later command.
- **A transition is a state snapshot, not an edge.** A till can go counting → open → counting between reconciles, and only the latest state reaches the server.
  - The last applied transition sets the status. Any transition from a non-closed session is accepted, and only a transition out of `closed` is refused.
  - A same-status transition is an applied no-op.
  - The server never refuses a transition because it didn't see an intermediate state.
- **Movements are accepted on any non-closed session,** `open` or `counting`, whatever their `createdAt`. They're refused with `register_session_closed` only once the session's closing transition or its closure has been applied (TallyUI ADR-032). The till always sequences the closing transition after every movement of its session.

**Operations are replay-safe by their till-minted ids.** Under the ledger's lease, a command whose write committed but whose ledger entry never completed (a crash) is re-executed with the same bytes. An existing session, movement, void or closure with the command's own id returns `ok` with the current state and writes nothing, and a transition to the status the session already has is a no-op `ok`. So a retry never turns a committed fact into a refusal, and it never writes the fact twice.

**The naming trap.** In medusapos, `order.create`'s `registerId` (order metadata `tally_register_id`) is the **till's device id** (ADR 0017). The register commands, the `tally_register` tables and `GET /tally/v1/registers/{id}` mean the **drawer**. They are never joined.

**Expected per tender and the sales count** are derived on the server (P2, TallyUI ADR-068 decision 13), equal to the till's `deriveExpected`:
- **`expected` is keyed by payment `method`.** `cash` is always present and starts at the session's `countedFloatMinor`. Each sale adds its payments' `amountMinor` (net of change), read from the order's `tally_payments` metadata as the till sent it, never from Medusa's totals or payment collections.
- **Movements change `cash` only.** paid-in adds and paid-out subtracts; per ADR-068 6a, `amountMinor` is always positive and `type` gives the direction. `no_sale` and void rows add nothing, and a voided movement is excluded.
- **`salesCount`** is the number of orders.
- **Which orders count:**
  - **live:** orders whose `tally_session_id` is the session;
  - **at and after the closure:** the orders in the closure's `orderIds`, whatever their `tally_session_id`, so v1/v2 orders enter only this way. The movements are those in its `movementIds`, plus the session's void rows, so a movement stranded by a racing close is left out.
  - An order counts when it isn't deleted, carries `tally_payments`, and has status `completed`, `archived` or `canceled`. Pending and draft orders were never received. **The reconciliation view answers what the till took during the session.** A later admin action (archive, cancel, refund) is a correction recorded elsewhere, and never rewrites a session's figure.
- **The closure's `variance`** is counted − expected, over `counted`'s keys only.
- **The till's `tillExpected` and `counted` are the fiscal record,** stored unchanged. The server's figures are a reconciliation view, computed on read, so an order that arrives late is included. The closure row's `expected` and `variance` columns stay null. Orders the server never received, and rejected orders, show up as the difference from `tillExpected`. No field is added for them.
- **Open question (post-c2):** when refunds arrive, a refund against a session's order goes into the refund figure, not out of `expected`.

## Consequences

- Delivery comes in steps:
  - P1a: the module and its service;
  - P1b: routing the five types through the command endpoint, validators, `result.register`, `/info` `register: [1]`, and `parseCommandResult` accepting register results without `serverRefs`;
  - P2: derivation and `GET /tally/v1/registers/{id}`;
  - P3: approval.
- `approvedBy` is stored as the till sends it, and isn't verified until c2c.
- A `closure.submit` whose `registerId` isn't its session's drawer is `invalid_payload`. ADR-068 decision 8 (unknown register ids accepted as written) covers `session.open`, which creates the register.
- **What's stored in the ledger:** applied results and the `register_*` business conflicts are stored, so a replay returns them exactly. `invalid_payload` isn't stored, whether it's a shape error or a state-dependent refusal (unknown session, void target missing, closure `registerId` mismatch). That follows ADR 0004, so a resend re-evaluates against the current state. A replay of a stored rejection returns the recorded `rejected` result with the same code, message and data, even if the current state would now accept it, and writes nothing (Front desk ruling, 2026-09-29, for TallyUI ADR-068). `duplicate` only ever means the command was applied, and carries the result recorded when it was applied, not the current state.
- **The claim check:** the register write path checks it still holds its ledger claim (`assertClaim`) just before the service call, as order.create does. The check and the write aren't one transaction, so a stalled worker whose lease was taken over can still write in that narrow window (ADR 0001). A stale transition would then flip open and counting until the next transition.
- A refused register command stops that register's queue on the till (ADR-068 decision 4). So the server refuses only what the till can't produce, and never turns a retry into a refusal.
- Refunds stay 0 in c2.

## Never-placed orders (2026-09-29)

A canceled order counts because an admin cancel is a later correction. An order canceled by `tally-ledger-resolve reject` was never placed: it carries `tally_rejected` and never counts, so the new order a retry creates is counted once. Only the order the rejected command parked is marked; an earlier order of the same sale that an admin canceled by hand keeps counting.

A failed `order.create` leaves no order row: Medusa's `createOrdersStep` compensation deletes it. The session figures integration test pins that deletion and counts the sale once after its retry.
