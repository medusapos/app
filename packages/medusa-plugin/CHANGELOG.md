# Changelog

## 0.3.0 — 2026-10-07

- **Added:** POS access under Medusa RBAC (ADR 0023). With `MEDUSA_FF_RBAC` on, every `/tally/v1` route needs the `tally_pos:use` permission; the script `tally-pos-roles` creates the roles POS cashier and POS manager. With RBAC off nothing changes.
- **Added:** `POST /tally/v1/register-approvals` with `{ sessionId, variance, email, password }`: a manager signs in at the till and gets a single-use proof valid for 15 minutes, bound to that session and variance. Under RBAC the manager needs `tally_pos:approve_variance`. Failed attempts are limited per requesting user and per manager email (429 `approval_rate_limited`). An account that needs MFA is refused `approval_mfa_unsupported`.
- **Added:** register contract 3. `register.closure.submit` accepts an optional `approval`; a cash variance over the threshold without one is refused `register_approval_required`, and a proof that is unknown, used, expired, or for another session or variance is refused `register_approval_invalid`. The closure answer carries `approvalVerified` at contract 3 only. Contracts 1 and 2 are unchanged.
- **Added:** plugin options `approvalThresholdMinor` (default 500) and `minRegisterContract` (unset accepts 1, 2 and 3); `/info` reports `registerApproval.thresholdMinor`.
- Needs the new migration (`npx medusa db:migrate`).

## 0.2.2 — 2026-10-07

- **Fixed:** a command on a session that was taken over is refused `register_session_superseded` (with the take-over data) when that session was opened at register contract 2, whatever the command's own contract; a session opened at contract 1 still gets `register_session_closed`. Needs the new migration (`npx medusa db:migrate`).

## 0.2.0 — 2026-10-06

- **Breaking (meaning):** `insufficient_stock.quantity` changes from the level's whole shortfall in variant units to the units of this sale that stock did not cover: min(units sold, shortfall in variant units). Selling 1 unit when stock is −1 now reports 1 instead of 2. The warning shape is unchanged.
- **Added:** `session.rejected` on `GET /tally/v1/registers/{id}` (medusapos/app#230), present only when non-zero; absent means zero.
