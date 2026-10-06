# Register v2: take-over, resume and unknown sessions

Status: Accepted
Date: 2026-10-06

## Context

Register c2 (ADR 0019) allows one live session per drawer. When a till is lost, broken or replaced, its session stays open and every other till's open is refused `register_session_already_open`, and no other till can move on until the lost one closes it. The same refusal hits a till that reinstalls or loses its local state and opens again on the drawer it already holds.

TallyUI ruled the cross-track contract on 2026-10-06 (TallyUI ADR-078; the ruling and the medusapos confirmation are `register-takeover-ruling-2026-10-06.md` and `register-takeover-confirmation-2026-10-06.md` in the agent handoff folder, answering TallyUI#371). This is the plugin half, medusapos#174 item 1.

## Decision

**Register contract version 2.** `/info` advertises `register: [1, 2]`. A v1 till sees v1 behaviour, byte for byte. Only `register.session.open` gains payload fields in v2; the other four commands keep their payloads, and their envelope version decides which refusal they get.

**The open gains two optional fields:**
- `deviceName`: 1 to 64 characters after trim, stored trimmed. The envelope's `deviceId` is stored on the session as sent. Both are shown to the till that is refused or displaced.
- `supersedes`: the id of the live session the till means to take over.

**The open, in one transaction, in this order** (a replayed command id has already returned its stored result before any of it):
1. **The session id exists.** Superseded: refused (below). Another drawer: `invalid_payload`. Otherwise `ok` with the current state, writing nothing (ADR 0019's replay rule).
2. **The session id is an alias** (v2 only): it answers for its session, as a resume.
3. **Same device resumes.** A v2 open whose `deviceId` equals the live session's stored `deviceId` resumes that session, whatever `supersedes` says. The store keeps the open's `sessionId` as a permanent alias of the live session (`tally_register_session_alias`) and answers `applied` with `register.session` = the live session, plus `openedAt`, `openingFloatMinor` (its counted opening float), and `expected` unless blind, and `register.resumed: { fromSessionId }`. The till never re-keys: every command it sends under its own id counts on the store's session through the alias.
4. **Take-over is a compare-and-set.** If `supersedes` names the live session, that session becomes `superseded` (recording when, by whom, from which device and for which new session) and the new session opens; the result carries `register.superseded: { sessionId, openedAt, deviceId?, deviceName? }`. If another session is live, the open is refused `register_session_already_open` with fresh data: `sessionId`, `registerId`, `openedAt`, `status`, and `openedBy`, `deviceId`, `deviceName` where recorded. If nothing is live any more, it is a plain open with no `superseded` in the result: nobody is displaced, and the cashier asked to sell. Two take-overs racing for one session: the update guarded by `status in ('open','counting')` lets one through, and the other loops and sees the winner as the live session.
5. **Otherwise** a plain open, as in v1. A v1 open on a held drawer is refused `register_session_already_open` with `{ sessionId }`, as before.

**`superseded` is final.** It is a fourth session status; the unique "one live session per drawer" index now covers `open` and `counting` only. A superseded session is never live again; a take-back is a new open with a new session id and `supersedes`. Any command naming a superseded session, or an alias of one, is refused:
- at contract ≥ 2: `register_session_superseded`, with `data` `{ sessionId, supersededAt, newSessionId, supersededBy?, deviceId?, deviceName? }`. TallyUI does not let this refusal block the register's later commands; each is refused on its own;
- at contract 1: `register_session_closed`, the code a v1 till already handles.
The refusal comes after the replay check, so a stored movement replayed after a take-over still answers `ok`. Refusals are stored in the ledger like the other `register_*` conflicts.

**Aliases everywhere.** Transition, movement record, movement void and closure submit lock the session through the alias (own id first, else alias → session, then `for update`), so they count on the real session. Live figures and the live `rejected` summary count orders whose `tally_session_id` is the session's id or any of its aliases. This reaches the register read, the `register.session` of every register result and the resume result. A closed session's figures still come from its closure's `orderIds`.

**An `order.create` naming an unknown session is applied, with a warning.** The money is real, so an order is never refused or changed because of its session. When the result is built, a `sessionId` that is neither a session id (any status, deleted or not) nor an alias id adds `{ code: 'register_session_unknown', sessionId }` after the existing warnings. The order keeps the till's id in `tally_session_id`. An open or a resume alias that arrives later counts it on that session from then on, with no re-key, because orders and register commands travel in separate outboxes and may arrive in either order. The warning means "not known when applied", never "abandoned". A replay returns the stored warning (`duplicate`). The warning is not version-gated: TallyUI reads warnings through `knownWarnings`, which drops codes it does not know, as with `customer_ignored`. `@tallyui/core` 3.5.1 does not list the code yet, so the plugin declares its shape once and widens `warnings` with one cast where results are built and one where stored results are parsed.

## Consequences

- **Migration** `Migration20261006120000` adds the device and supersede columns to `tally_register_session`, widens the status check to `superseded`, narrows the live-session index to `open`/`counting`, and creates `tally_register_session_alias`. Its `down` restores the old index and check; it fails if any session is already `superseded`, so a rollback after a take-over needs those rows closed first.
- **Not built: listing a session nobody holds.** The confirmation says the register read lists an abandoned session's orders for reconciliation. They are recorded with their `tally_session_id` and counted by no session, but no read lists them yet. That needs a new wire field, so it waits for TallyUI to ask for it; until then they are found by order metadata.
- `register_supersede_forbidden` stays reserved: anyone who may open the drawer may take it over. Who may is enforced only by the open's own auth, as in v1.
- A resume trusts `deviceId` as the till sends it. A till that copies another's device id could resume its session. That is the same trust c2 gives every till-minted field until c2c (P3) adds approval.
- Superseding is allowed from `counting`. The superseded session's movements and sales already recorded stay on it, and it can never be closed, so it has no Z. The register read shows the live session, else the latest opened; a superseded session's figures are not on it while another session is live. The cash on it is accounted for by the till's own record and the owner.
- Delivered in steps on one branch: R1a (the open in the service), R1b (the open through the commands endpoint and `/info`), R2 (later commands resolve aliases and refuse superseded sessions), R2b (figures resolve aliases; unknown sessions warn), R3 (this ADR).
