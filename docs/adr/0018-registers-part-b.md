# Registers, part B: the count, the closure sheet, the Z figures and the approval gate

Status: Accepted
Date: 2026-09-28

## Context

Part A (ADR 0017) bound the till to a register, opened it with a float and
recorded cash movements; its Close register reached a placeholder. TallyUI
`1b0c094`, already pinned, carries Job B (#166: `RegisterCount`,
`ClosureSheet`, `buildClosureDocument`) and #168 (`approvedBy` and
`approvedByName` threaded to `closeSession`, the closure's
`breakdowns.approved_by` / `approved_by_name` and the session's
`approved_by`; `RegisterApprovalRequiredError`, the hook's own gate). Part B
is finished on `25665e1` (#172: `requireSaleSession()` and
`startTender(method, { session })`; #174: `ClosureSheet` shows the approver,
`RegisterColumn`'s Finish closing card, and complete closure-document types).

A close whose cash count is off by more than a threshold needs someone to
approve it. The Front desk (2026-09-28) chose how: option (b), a second
Medusa admin login, now; option (a), a manager PIN in the plugin, later.
Never option (c), a deferred approval: the TallyUI gate stays intact, and a
close can't complete over the threshold without an approver.

## Decision

- **The count.** `RegisterColumn`'s `countSlot` is TallyUI's
  `RegisterCount` (denomination tiles or a typed amount, other tenders, the
  live variance, Back to selling and Close register). Part A's
  `RegisterCountSlot` placeholder is gone. `blind` stays off.
- **The threshold** is `VARIANCE_THRESHOLD_MINOR`, 500 minor units (€5.00),
  a constant in `lib/approval.ts` passed to `useRegisterSession` as
  `varianceThreshold`. A per-store setting can replace it later.
- **`approve()` is a second Medusa admin login** (`useApprove`,
  `components/register-close.tsx`). Over the threshold, `RegisterCount` calls
  it before `closeSession`. It opens a "Manager approval" dialog with Email,
  Password, Approve and Cancel.
  - Approve calls the app's own `login()` (`lib/session.ts`), which neither
    saves nor replaces the cashier's session. It then reads
    `GET /admin/users/me` with the returned token (`requestApproval`,
    `lib/approval.ts`). It resolves
    `{ approvedBy: user.id, approvedByName }`, where `approvedByName` is
    "first_name last_name", or else the user's email. `RegisterCount`
    passes both to `closeSession`, and TallyUI freezes them on the Z.
  - **The password and the token are never kept.** The password leaves the
    dialog's state when Approve is pressed: the field is cleared whatever the
    answer, and the dialog unmounts on success. The token is a local variable
    dropped once `/me` returns. Neither is logged, stored or put in a URL.
    Tests spy on the console, on storage and on every request URL to prove
    this. The token is dropped on this device only: on the server it stays
    valid until it expires, because Medusa tokens can't be revoked.
  - **Autofill.** The app avoids it: the password field is
    `autoComplete="new-password"` (browsers ignore `"off"` on a password
    field) and the email field `"off"`, so the browser doesn't fill in the
    cashier's saved login. A browser may still offer to save the manager's
    password after Approve. The app can't prevent that, so testers.md tells
    cashiers never to save it on the till.
  - A wrong password shows "That email and password didn't work." and the
    dialog stays open. Cancel resolves `null`, which `RegisterCount` shows as
    "Approval was not granted. The count is unchanged."
  - **A hung request never locks the till** (#89 review). `requestApproval`
    takes an `AbortSignal` for both requests, and gives up after
    `APPROVAL_TIMEOUT_MS` (15 s) as offline. Cancel, Escape and closing the
    dialog work while a request is in flight: they abort it and resolve
    `null` at once. The dialog answers exactly once, so an answer that
    arrives after Cancel or the timeout is ignored. It never approves, never
    closes the register, and never records the approver.
  - **Offline** (the catalogue's sync state is `'offline'`, the sign-in or
    `/me` fails with a network error, or the approval times out), the dialog
    shows "Connect to approve, or count again." with only Cancel.
  - **Self-approval is allowed.** A solo owner approves with their own login.
    Medusa 2.21 has no admin roles, so any admin can approve. This records
    who approved; it does not stop a cashier who knows an admin's password.
    **Option (a), a manager PIN in the plugin, replaces this** when that
    plugin work is scheduled.
- **The hook's own gate.** `closeSession` re-reads storage and throws
  `RegisterApprovalRequiredError` before any write when a close over the
  threshold carries no `approvedBy`. For example, a paid in could land after
  the count rendered. `RegisterCount` shows it as its refusal, "Manager
  approval needed. Ask a manager to approve, or count again.", and nothing
  is written.
- **Approver names for a resumed close.** The session stores the approver's
  id but not their name. A close resumed after a restart therefore names the
  approver through `labels.resolveCashierName`. The app keeps a small
  id → name map per backend (`medusapos.approvers.<baseUrl>`, like ADR
  0016's device settings; at most 50 entries, ids and names only). Each
  approval adds to it, and `resolveCashierName` reads it, falling back to
  the id. Cashier ids are their emails, so they resolve to themselves.
  `labels.registerName` is the bound register's name.
- **A close that didn't finish** (#88 review). TallyUI's `currentSession`
  keeps returning a session that is `closed` but whose closure row was never
  written, and `openSession` refuses with `RegisterCloseIncompleteError`
  until its close finishes. Showing the open card would therefore be a dead
  end. The gate renders `RegisterColumn` for that session, and the column
  shows TallyUI's "Finish closing" card (#174) in place of the cart. The card
  resumes the close through `closeSession` with the count and approver
  already stored on the session (a resumed close isn't gated again), and
  shows any error. When the count's own close failed, the gate shows that
  error above the card, so the cashier sees why. Both closes go through the
  app's close flow, so the closure sheet follows, then the open card. On a
  phone the cart view opens for it.
  - While the count's own closure is written, the session is already
    `closed`, and it stays `closed` in the render just after the close
    resolves. For that session (`close.maskedSession`, set when the count
    closes and cleared if it fails) the gate gives `RegisterColumn` the
    session as `counting`. The count stays on screen instead of flashing the
    card, whose button would start a second close. A close found unfinished
    at start-up always gets the card. TallyUI's coming `closing` flag on
    `useRegisterSession` will replace this masking.
- **The close flow lives in `RegisterProvider`** (`close`, #89 review): the
  close itself, the closure whose sheet shows, the masked session and the
  last error. `RegisterClosedSheet` is mounted by the sale screen, not the
  gate. So on a phone, leaving the cart view mid-close (which unmounts the
  gate) loses neither the sheet nor the masking.
- **After the close.** When `closeSession` resolves, the sale screen shows TallyUI's
  `ClosureSheet` for that closure (no `onPrint` yet). Its Done goes back to
  selling, where `OpenRegisterCard` is prefilled with the last counted cash.
  Since #174 `ClosureSheet` itself shows "Approved by {approved_by_name, or
  else approved_by}" under the figures, blind or not, only when the closure
  has an approver. The app's own floating line is gone. "Approval pending"
  never appears, because a close can't complete without approval.
- **The last closure's figures (the Z).** Between sessions, when the
  register is closed, "Register ›" opens `LastClosureSheet` in place of the
  panel, which would otherwise show only disabled controls. This is the
  smaller change than a new route. The sheet renders
  `buildClosureDocument(register.lastClosure, context)` and nothing
  recomputed: the closure number; the opened and closed times; the period
  sales; the opening float; expected, counted and variance per tender; the
  movements, with undone ones marked; a warning when sales are unsynced
  (count and total); and "Approved by {name}" when there is an approver.
  The `context` is:
  - pricing's currency, with `minorUnitDigits` as `exponent`;
  - `timezone: 'device'`;
  - the device locale (`expo-localization`);
  - `formatMoney` from `@tallyui/core`, fed the envelope's decimal text;
  - short English `i18n` strings;
  - the store settings' name and address;
  - `printedAt` = now.
- **On a phone** the count lives in the cart view (ADR 0009). The sale screen
  therefore opens the cart view when the session starts counting, or when a
  close didn't finish, even with an empty cart. The pill opens the panel
  only for an open session; otherwise it brings up the gate.
- **The tender pins the session the gate confirmed** (TallyUI `c5fe200`,
  #172). `useGatedSale`'s Cash and Card await `register.requireSaleSession()`
  (requireOpen's checks, returning `{ id, sessions }`, or `null` while
  sessions are off), then call `startTender(method, { session })`, and
  `useSale` pins that explicit session for the tender. This replaces part A's
  wait for the rendered session (ADR 0017, "The tender waits for the
  rendered session": the `pending` state and its 3 s timeout are gone),
  since a session opened just before the tap is now passed in directly.
  Everything else in the gate stays: taps are ignored while a check is
  pending; the tender starts only if the sale is still at the cart; "Getting
  ready to save sales…" shows until the order store opens; and the refusals
  "Open the register to take payment." and "Couldn't check the register. Try
  again." are unchanged. A close during the tender still makes the sale late
  (`lateSessionId`). TallyUI's backstop covers a tender that pinned no
  session but has one rendered by `complete()`: it stamps that session and
  logs a warning. `RegisterCount` can't start while a sale is at tender
  (`RegisterTenderInProgressError`).

## Consequences

- An over-threshold close needs the network. Offline, the cashier counts
  again or waits.
- The approval is as strong as Medusa admin passwords are secret, and no
  stronger: every admin is equal.
- The Z figures are shown, not printed. Printing and a Z template are
  registers c2.

## Known limitations

- **Accepted: the Last closure view is reachable only between sessions.**
  "Register ›" opens it only while no session is open; once the next session
  opens, "Register ›" is the panel again, and the last closure can't be
  viewed until that session closes. Follow-up: a Register menu entry once
  registers c2 lands.
- The approver-name map is per device. A close resumed on another till, which
  can't happen while sessions are local-only, would name the approver by id.
