# 0023: Who may use the POS, and a verified manager approval (ADR 0018 follow-up)

Status: Proposed
Date: 2026-10-07

## Context

Two gaps in `docs/V2-PARITY.md` share one design, so the front desk (2026-10-07) asked for one ADR before any spec:

- **Gap 6, roles and capabilities.** Any Medusa admin can sign in to the POS. The plugin's `/tally/v1/*` routes use `authenticate('user', ['bearer', 'session'])` and never read who sent a command.
- **Gap 4, approval.** Since ADR 0018, a close over `VARIANCE_THRESHOLD_MINOR` needs a second Medusa admin login on the till. The plugin stores the till's `approvedBy` string as it arrives: recorded, not verified. The front desk ruled out a "the user exists" check, because it would claim a verification it does not do. It set the shape instead:
  - the manager authenticates against the store with their own credential, verified server side;
  - the store issues a short-lived, single-use proof bound to the register session and the variance;
  - the close carries the proof, and the plugin verifies it.

The till signs in through TallyUI's `medusaAdminUserAuth` connector (`apps/expo/lib/session.ts`, `lib/pos-connector.ts`). The catalogue, store, sales channel and profile reads use that admin `user` token against `/admin/*`, and only commands, changes and the register read go to `/tally/v1/*`. So a POS user has to be a Medusa admin user. A separate actor type would need a second token for `/admin/*`.

**What Medusa 2.21.0 already provides** (read from the published 2.21.0 packages, `@medusajs/medusa`, `framework`, `auth`, `rbac`, `api-key`, `user`):

- **RBAC, behind a feature flag.**
  - The flag is `rbac` (`MEDUSA_FF_RBAC`), off by default. It loads `@medusajs/rbac`, which is self-hosted, not Cloud-only, and has no docs.medusajs.com page yet. Treat it as a beta.
  - Its tables are roles (`rbac_role`), policies (`rbac_policy`: `resource`, `operation`), role ⇄ policy, role inheritance, and a user ⇄ role link.
  - Its migration seeds `role_super_admin` with `*:*`, and a bundled migration script links every existing user to it.
  - A plugin declares its own policies with `definePolicies({ name, resource, operation })` from `@medusajs/framework/utils`. Custom operations are allowed.
  - A middleware entry guards a route with `policies: [{ resource, operation }]`. `hasPermission({ roles, actions, container })` checks in code.
  - **With the flag off, both allow everything.**
  - The user's role ids are copied into the JWT (`app_metadata.roles`) when the token is issued. A role change reaches a token at its next sign-in or refresh.
- **Checking a credential server side.** `authModuleService.authenticate('emailpass', { body: { email, password } })` returns `{ success, authIdentity, mfaChallenge? }` and mints no token. When the identity has MFA, `success` comes with an `mfaChallenge`, which is not yet a verified sign-in.
- **No PIN provider.** A custom `AbstractAuthModuleProvider` is possible, but this ADR doesn't need one.
- **Tokens can't be revoked.** JWT verification is stateless; `http.jwtExpiresIn` defaults to `1d`.
  - `generateJwtToken` signs with `jwtSecret`, so a proof signed that way could pass as a bearer token.
  - Medusa's own single-use secrets don't use JWTs. Password-reset and invite tokens are random values with an `expires_at`, deleted on use.
- **API keys** are `publishable` or `secret`, with no scopes and no owning user. A secret key authenticates only routes whose actor list is exactly `['user']`, as `actor_type: 'api-key'`.

## Decision

### Who may use the POS

**Medusa RBAC is the one model.** The plugin declares two policies with `definePolicies`, and adds no role table of its own:

| Policy | Means |
|---|---|
| `tally_pos:use` | May sign in to the POS and send its commands. |
| `tally_pos:approve_variance` | May approve a close over the variance threshold. |

- **The check is server side, on every `/tally/v1/*` route.** Each middleware entry adds `policies: [{ resource: 'tally_pos', operation: 'use' }]`, and the route keeps `authenticate('user', ['bearer', 'session'])`. Medusa's router then refuses a token whose roles don't grant it, with 403. That includes `/tally/v1/info`, which the connector reads at sign-in (ADR-062).
- **At sign-in.** When `/info` answers 403, the app says "This account can't use the POS. Ask the store owner for POS access." and keeps no session. A 403 later, on a command or a pull, signs the till out like a 401, with the same words.
- **A secret API key** has no roles, so with RBAC on it is refused on every `/tally/v1/*` route. With RBAC off it is accepted, as today.
- **With RBAC off,** the policies are inert and every admin may use the POS, as today. The plugin adds no fallback list. A store that wants POS-only staff turns RBAC on. That is Medusa's own switch, and it also confines those staff in Medusa Admin. A plugin-side list would gate only `/tally/v1/*`, while the same token stays a full admin token for `/admin/*`.
- **Two roles to start from.** A plugin script, `tally-pos-roles`, creates them idempotently. A store edits or replaces them in Medusa Admin.
  - **"POS cashier"** has `tally_pos:use` plus the read policies the connector's `/admin/*` reads need (products, variants, inventory, store, sales channels, customers, the user's own profile). The sign-in spec pins the exact list with an e2e against a store with the flag on.
  - **"POS manager"** inherits "POS cashier" and adds `tally_pos:approve_variance`.
  - `role_super_admin` (`*:*`) already grants both policies, so a store's existing admins keep working.
- **Revoking access.** Roles live in the token, so removing a role from a signed-in cashier takes effect at their next sign-in or token refresh. That is within a day (ADR 0002: tokens live about a day, and the app refreshes within six hours of expiry). Medusa tokens can't be revoked, so an immediate stop means rotating `jwtSecret`. testers.md says so. The approval below reads roles live, not from a token.

### Who counts as a manager

A manager is a Medusa user whose roles grant `tally_pos:approve_variance`, read live from the database at the moment of approval: `query.graph` of the user's role ids, then `hasPermission`. With RBAC off, every admin counts, as in ADR 0018. The difference from today is that the store now verifies the credential, not the till.

- **Self-approval stays allowed.** A cashier who is also a manager approves their own close, as a solo owner does today. With RBAC on, a cashier who is only "POS cashier" can't.
- **Managers with MFA are refused for now.** An approval whose `authenticate` returns an `mfaChallenge` is refused `approval_mfa_unsupported`, and the dialog says "This manager's login needs a second step, which the POS can't do yet." An MFA step in the dialog is a follow-up.

### Issuing the proof

A new route: **`POST /tally/v1/register-approvals`**, behind the same `authenticate` and `tally_pos:use`. The caller is the signed-in cashier's till.

- **Body:** `{ sessionId, variance, email, password }`. `variance` is the per-tender map `counted − tillExpected` in minor units (`{ cash: -720 }`), the same keys and integers as the closure's `counted` and `tillExpected`.
- **In order:**
  1. **The session.** `sessionId` resolves through an alias (ADR 0022), under the session's lock, to one of:
     - a session that is `open` or `counting`;
     - a `closed` session with no closure yet. That is ADR 0018's "Close not finished", where a re-approval happens.

     A superseded session, or one with a closure, is 409 `approval_session_closed`. An id the store doesn't know is 409 `approval_session_unknown`. The till asks for approval only after the store has applied the session's open or resume (TallyUI ask, below), so an approval never overtakes the open that creates its session or alias.
  2. **Rate limit,** keyed by who asks and who is asked, not by session, because a cashier can open sessions at will. In 15 minutes the store allows:
     - 5 failed credential checks per requesting actor (the cashier token's `actor_id`);
     - 10 per target email, across all tills.

     Past either limit the answer is 429 `approval_rate_limited`. Admission is atomic. The attempt's row is inserted before the credential check, in a transaction holding `pg_advisory_xact_lock` on the requesting actor, and pending rows count. So parallel requests can't slip past the limit. The endpoint is a password oracle behind a cashier token, and the plugin can't count on a rate limit in front of the store. The rows live in the plugin's approval table, not the cache module, so the limit survives a restart.
  3. **The credential.** `authModuleService.authenticate('emailpass', …)`, server side. Failure is 401 `approval_invalid_credentials`. An `mfaChallenge` is 401 `approval_mfa_unsupported`.
  4. **The permission.** The identity's `app_metadata.user_id` must be a user whose live roles grant `tally_pos:approve_variance`. Otherwise 403 `approval_forbidden`.
  5. **Issue.** 32 random bytes, base64url, are the proof. The store keeps only their sha256.
- **The answer:** `{ approval, approvedBy: user.id, approvedByName, expiresAt }`. `approvedByName` is the user's "first last", else their email, as in ADR 0018.
- **No manager token is ever minted.** Today's second login gives the till a day-long admin JWT for the manager, which can't be revoked. This route never does.
- **The proof is opaque, not a JWT.** A random value and a stored hash make single use natural. It can never verify as a bearer token, which a JWT signed with `jwtSecret` could. This is the same pattern as Medusa's password-reset tokens.
- **The proof ledger is `tally_register_approval`:**
  - `id`, `token_hash` (unique), `session_id` (the canonical session, not the alias), `variance` (jsonb), `approved_by`, `approved_by_name`;
  - `requested_by` (the cashier token's `actor_id`), `created_at`, `expires_at`;
  - `used_at`, `used_by_command_id`, `closure_id`.
  - Failed attempts are rows with no `token_hash`.
- **Short-lived:** `APPROVAL_TTL_MS`, 15 minutes, a constant in the plugin with a comment. The till asks only while it is online, and the close commands follow at once.

### Verifying it in the close

**`register.closure.submit` carries the proof**, as a new optional `approval` field from **register contract 3**. The closing transition doesn't carry it: the closure is the only command with both `counted` and `tillExpected`, so it is the only one whose variance the plugin can check exactly. It is also the record that freezes the approver on the Z.

In the closure's own transaction, after the replay check, the plugin does the following:

0. **An existing closure comes first.** If a closure with this `closureId` already exists, `submitClosure` answers for it as today, before any proof check. A crash after the closure committed but before the ledger completed (`execute.ts` commits the closure, then calls `ledger.complete`) is re-run after the lease. That re-run finds its own closure and answers `applied`, even after the proof's expiry, and never `used` or `expired`.
1. **The variance and the threshold.** The plugin computes the variance from the payload (`counted − tillExpected` per tender). The threshold is the store's `approvalThresholdMinor`, a plugin option with a default of 500. `/info` advertises it as `registerApproval: { thresholdMinor }`, so the till's gate and the store's agree. It replaces the app's `VARIANCE_THRESHOLD_MINOR` constant, as ADR 0018 foresaw. The plugin applies it exactly as TallyUI's `varianceThreshold` gate does; the approval spec pins that rule from `@tallyui/core`'s source.
2. **Over the threshold with no `approval`:** refused `register_approval_required`, `data: { sessionId, thresholdMinor, variance }`.
3. **With an `approval`.** The plugin locks the row by `token_hash` (`for update`) and refuses `register_approval_invalid` with `data.reason` set to one of:
   - `unknown`;
   - `expired`: `expires_at` has passed when the command arrives;
   - `used`: it was used by another command id;
   - `session_mismatch`: its session is not this closure's session after aliases;
   - `variance_mismatch`: its `variance` is not this closure's computed variance.

   Otherwise the plugin marks the row used by this command and closure. The closure's `approved_by` is the row's `approved_by`, whatever the payload's `approvedBy` said. The session's `approved_by` is set to match, and `tally_register_closure.approval_id` records which proof it was.
4. **A replay** of the same command id returns its stored result before any of this (ADR 0019), so a retried closure never trips `used`.

Refusals are stored in the ledger like the other `register_*` conflicts. Under the threshold, an `approval` is still verified and recorded if present, because the cashier asked a manager anyway.

**Contracts 1 and 2 are unchanged.** `approvedBy` stays recorded, not verified, and no threshold is enforced, because a till at those contracts can't send a proof. The register read gains `approvalVerified` per closure (`approval_id is not null`), so the owner can tell a verified approval from a recorded one. A store that wants every close verified can set the plugin option `minRegisterContract: 3`, which refuses older tills' register commands with the existing `unsupported_version`. It defaults to off, so updating the plugin never strands a till.

**A refused proof, recovered.** A closure that reaches the store more than 15 minutes after its approval is refused `expired`. A proof can also be refused `used` or `variance_mismatch`, or missing (`register_approval_required`). In each case the closure already exists on the till: it was written locally and queued. So recovery is not ADR 0018's Finish closing card, which is for a closure that was never written. It is a server refusal of a queued command. TallyUI's ask (below) defines it:
1. The refused `register.closure.submit` is marked rejected in the outbox. The stored rejection replays for its command id (ADR 0019), so it is never resent as is.
2. The register shows a "Manager approval needed again" card for the stored closure, with the same count and the same `closureId`. It runs the approval dialog against the route; the session is `closed` with no closure at the store, which step 1 of the route allows.
3. The till queues a replacement `register.closure.submit` under a new command id, with the same `closureId` and payload plus the new `approval`.

Only the closure command waits on this. The register's other queued commands are not blocked by it, the same rule ADR 0022 set for `register_session_superseded`. This is the price of "short-lived". It only bites a till that lost the network between the approval and the closure.

### What the till stores

- **The cashier's token, as ADR 0002 says.** Nothing new.
- **The manager's password, never,** with the same rules and tests as ADR 0018: cleared on Approve and never logged, stored or put in a URL. It is now sent only to `/tally/v1/register-approvals` in a POST body, over HTTPS.
- **No manager token.** None is minted.
- **The proof** goes from the dialog through `closeSession` into the closure command, so it is in the outbox until the closure is delivered, and stays in the stored payload after. That is acceptable: it is single use, bound to one session and one variance, and dead after 15 minutes or its first use. The till keeps no other copy.
- **The approver map** (`medusapos.approvers.<baseUrl>`, ADR 0018) is unchanged: ids and names only.

### Migration for existing installs

- **The plugin migration** creates `tally_register_approval` and adds `approval_id` (nullable) to `tally_register_closure`. Its `down` drops both. Existing closures keep `approval_id` null, so they read as recorded, not verified, which is true.
- **The `/info` contract becomes `register: [1, 2, 3]`.** A till at 1 or 2 sees no change.
- **With RBAC off,** which is every store today, nothing changes for sign-in: every admin may use the POS and approve. Approvals from a contract-3 till are now verified server side. QUICKSTART.md and testers.md say how to turn RBAC on.
- **Turning RBAC on** is the store owner's step, with Medusa's own flag:
  1. Set `MEDUSA_FF_RBAC=true` and run `db:migrate`. That seeds `role_super_admin` and links every existing user to it, so nobody is locked out.
  2. Run `medusa exec tally-pos-roles` to create the two roles.
  3. Move cashiers from super admin to "POS cashier" in Medusa Admin.

  The sign-in spec proves the order with an e2e: a "POS cashier" signs in and sells, a user with no POS role is refused at sign-in, and a super admin still works.
- **The app**, once it sees `registerApproval` in `/info`, replaces ADR 0018's second login with the approval route, and sends `approval` on the closure at contract 3. A store whose plugin predates this keeps the second-login dialog and contract 2.

### What vendurepos can copy

The wire contract is TallyUI's, so register contract 3 is the same on both stores: the `approval` field, the two refusals and their `data`, `registerApproval` in `/info`, and the approval route's body and answer. What differs is only how each store checks a user:

- **The two permissions.** Vendure has core custom permissions: a `PermissionDefinition` in the plugin's configuration, assigned to Vendure roles. vendurepos declares `UseTallyPos` and `ApproveTallyPosVariance`, the same two capabilities, and needs no feature flag or "with RBAC off" branch. Its roles row in its own parity list can close on that.
- **The manager check.** It uses Vendure's own authentication strategy, server side (the native strategy's credential check), with the same MFA-style refusal if the strategy asks for more.
- **The rest copies as is:** the opaque proof, its hash and its ledger table, the 15-minute TTL, the per-session failure limit, the closure-time verification and its order, and the contract-1/2 "recorded" rule.

Nothing here reads or depends on vendurepos code. Its worker takes this section as a reference.

## Consequences

- **Two one-way PRs, in this order:**
  1. **Sign-in:** the policies, middleware `policies`, the `/info` 403 handling in the app, `tally-pos-roles`, and the RBAC-on e2e.
  2. **Approval:** the migration, the route, register contract 3 in the plugin, the app's approval dialog against the route, and its e2e.
- **A cross-track ask for TallyUI blocks PR 2.** The front desk files it, as with ADR-078. TallyUI must:
  - carry `approval` through `closeSession` into the closure payload at register contract 3;
  - take the threshold from the connector (`registerApproval.thresholdMinor`);
  - expose whether the session's open or resume has been applied at the store, so the app asks for approval only then;
  - recover from `register_approval_required` and `register_approval_invalid` as above: re-approval for the stored closure, a replacement command with the same `closureId`, and no block on the register's other commands.

  PR 1 needs nothing from TallyUI.
- **RBAC is a Medusa beta with no docs page.** If Medusa changes its policy API before it leaves beta, only the `definePolicies` declarations, the middleware entries and the one `hasPermission` call change. With the flag off, none of it runs.
- **With RBAC off, "manager" means "any admin".** The approval is now verified (a real credential, checked by the store, for this session and this variance), but it is no stronger than admin passwords are secret, as ADR 0018 said. The Z can say so: `approvalVerified` is true, and the role check is as strong as the store's RBAC setting.
- **A closure that crosses the threshold with a stale proof stays unclosed at the store** until the till re-approves. The register read shows the session `closed` without a closure, as for any "Close not finished".
- **Not built:**
  - a PIN credential, which would need a custom auth provider;
  - an MFA step in the approval dialog;
  - a per-store threshold UI (the threshold is a plugin option);
  - recording the sending user on every command (`openedBy`, `closedBy` and `createdBy` stay till data).

## Questions for the front desk (with recommendations)

1. **No plugin-side POS-access list with RBAC off**: every admin may use the POS until the store turns RBAC on. *Recommend yes.* A list would gate only the plugin's `/tally/v1/*` routes. The same user keeps full Medusa Admin and `/admin/*` access, so it would look like confinement without being it. RBAC confines both, and it is Medusa's own switch. Codex's review disagrees: a list is still a real gate on POS operations. That is true, but it is a second permission model to maintain beside RBAC.
2. **The proof rides on `register.closure.submit`, not the closing transition.** *Recommend yes.* It is the only command whose variance the plugin can check exactly.
3. **TTL of 15 minutes, with an expired proof refused and the till re-approving.** *Recommend yes,* with the recovery above. The alternative is a long TTL, which isn't short-lived. The binding to one session, one variance and one use already makes a leaked proof worth nothing beyond that close.
4. **Managers with MFA are refused until an MFA step lands.** *Recommend yes.* MFA in 2.21 is enrolled per identity (factors and challenges in the auth module), so this refuses only managers who enrolled a factor. The MFA step is the first follow-up.
