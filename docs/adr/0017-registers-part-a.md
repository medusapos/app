# Registers, part A: bind, open with a float, the bar, the panel, cash movements

Status: Accepted
Date: 2026-09-28

## Context

TallyUI `451a0ca` (TallyUI #164, "register screens, Job A") ships the register
screens on top of `useRegisterSession` (TallyUI ADR-032): `RegisterPicker`,
`OpenRegisterCard`, `RegisterBar`, `RegisterPanel`, `MovementSheet` and
`RegisterColumn`. ADR 0015 adopted `pos_orders` schema v2 but left
`useRegisterSession` unused and passed no `session` to `useSale`. This ADR
adopts the register for part A: bind the till to a register, open it with a
float, show its status and panel, and record paid in, paid out and no sale.
Counting, the closure and approval (Job B, TallyUI #166) are wired in part B.

TallyUI has no server side for registers yet (registers c2): sessions,
movements and closures are local-only collections, never replicated.

## Decision

- **Pin.** Part A was built on `TALLYUI_REF` `451a0ca` (TallyUI #164) and
  finished on `562e62e` (TallyUI #167: `RegisterBar`'s `onPressPill`,
  Catalogue's `statusAccessory`, the open card's float label with its
  currency, picker and open card that size to their content). `562e62e`
  also carries Job B (#166), which part A doesn't wire: its counting stays
  the placeholder below until part B.
- **Storage.** `register_sessions` (`registerSessionCollection()`, which
  also carries the till's `register` local document), `cash_movements` and
  `closures` are added to the existing per-backend order store
  (`openOrderStore` in `lib/order-store.ts`), next to `pos_orders`, after
  its migration and legacy carry-over. They share its single instance
  (`multiInstance: false`), its close and close-wait, its storage watchdog
  and the #85 reopen backstop, so there is no second database with its own
  close story. They are new, so nothing is migrated or carried over. The
  open then calls `ensureRegister(register_sessions, 'web')` once per
  database open (shared handles don't repeat it), which mints the till's
  `register` document on first use and reads it after that.
  `registerCollections(orders)` reaches them from the outbox's `orders`.
- **One register session, one place.** `RegisterProvider`
  (`lib/register-context.tsx`) holds the app's only `useRegisterSession`,
  over the outbox's open store. `OutboxProvider` renders it around its
  children, so any screen under the outbox (the sale screen today, Job B's
  count screen later) reads the same instance through `useRegister()`.
  Options: `storeKey` is `session.baseUrl` (the order store's key),
  `actor` is `{ id: session.email, name: session.email }`,
  `timezone: 'device'`, `softwareVersion` is `apps/expo/package.json`'s
  `version`, `tenderInProgress` is the sale screen's
  `sale.stage.kind === 'tender'` (reported up through `useRegister()`), and
  `enabled` is "the register collections are open". `expectedCloseTime`,
  `varianceThreshold` and `blind` stay unset.
- **Register list.** No server supplies one, so every backend offers one
  default register, `{ id: 'register-1', name: 'Register 1' }`
  (`DEFAULT_REGISTERS`, to be replaced by a server list). `multiRegister` is
  false, so the bar never names it. Binding is still explicit: a fresh till
  shows `RegisterPicker`, and a pick calls TallyUI's
  `bindRegister(host, storeKey, register)` on the till's `register`
  document. The bound id is read back from that document
  (`observeRegister$` + `getBoundRegisterId`), never kept in app state.
- **Naming.** `registerId` stays what it has always been in this app: the
  till's own device id (`getDeviceId(..., REGISTER_ID_KEY)`), stamped as
  `PosOrder.registerId` and sent by the outbox. The TallyUI register (the
  drawer) the till is bound to is `boundRegisterId` in app code, including
  where it is passed as TallyUI's `registerId` option or prop.
- **The gate is at paying, not at browsing or adding** (the Front desk,
  2026-09-28; TallyUI c1).
  - Browsing, taps, scans and the cart work whether the register is
    unbound, closed or open.
  - The Cart gets a `sale` whose `startTender` first awaits
    `register.requireOpen()` (`useGatedSale`, `components/register.tsx`).
    On `RegisterSessionRequiredError` the tender doesn't start and an
    `alert` above the cart says "Open the register to take payment.".
    `requireOpen()` resolves null only while sessions are off; the tender
    then starts as before. Sessions are never off in this app (`enabled` is
    true once the collections are open), and until they are open the Cash
    and Card buttons refuse the same way, since there would be no session
    to check or to stamp.
  - `useSale` gets `session: register.saleSession`, so `complete()` stamps
    the order through `stampSession`, and a session closed under a tender
    makes it a late sale (`lateSessionId`), as TallyUI decides.
  - There is no second `requireOpen()` before the card terminal: the app
    doesn't drive a terminal. "Payment approved on terminal" is pressed
    after the terminal has taken the money, so refusing there would lose a
    paid sale; the completion's `stampSession` (late sale) covers it.
  - **Where the gate shows.** `RegisterColumn` swaps the cart out
    wholesale, so the app doesn't use it for the gate. `RegisterGate`
    composes `RegisterPicker` (unbound) or `OpenRegisterCard` (bound, no
    session) directly **above** the cart, which stays usable below: in the
    cart column when wide, in the cart view on a phone (ADR 0009). Once a
    session exists, the cart sits inside `RegisterColumn`, used only for its
    `'counting'` swap to `countSlot`.
- **The register bar** is TallyUI's `RegisterBar` (`TillRegisterBar`),
  `print: 'hide'`, not on the receipt. `online` is false while the
  catalogue's sync state is `'offline'`. The Front desk's review
  (2026-09-28) wants the pill never to be a dead label, so the app passes
  `onPressPill` (TallyUI #167), which makes it a button:
  - without a session ("Choose a register", "Register closed") it brings up
    the gate: wide, it scrolls the cart column's gate into view and focuses
    its first control; on a phone, it opens the cart view, even with an
    empty cart (the cart bar itself stays disabled then);
  - with a session, it opens the panel, as "Register ›" does.
- **Where it sits.** Wide (≥ 600 px): its own strip under the navigation
  header, above the earlier-sale and saving notes. On a phone (ADR 0009)
  there is no strip: the same bar, without its strip height, padding,
  border and background (`IN_ROW`), ends rows that already exist: the cart
  view's "‹ Products" row, and on Products Catalogue's status line under the
  search box (its `statusAccessory`, TallyUI #167).
- **The panel.** "Register ›" opens `RegisterPanel` (currency from
  pricing), whose Paid in, Paid out and No sale open TallyUI's
  `MovementSheet`, and whose Undo calls `voidMovement`. No `onOpenDrawer`:
  the app has no drawer hardware.
- **Close register** calls `startCounting()`. The panel has no prop to hide
  it, so the `'counting'` state gets `RegisterCountSlot`: "Counting arrives
  in the next update." with **Back to selling** (`backToSelling()`).
- **One root `PortalHost`** (`@tallyui/primitives`) in `app/_layout.tsx`,
  after `GatedApp` and outside every gate, per TallyUI's integration guide
  at `451a0ca`. The panel and movement sheet (`Dialog`) render there. No
  existing app screen used a portal before, so the #80 prompt, the
  store-settings choice and the discount form render as they did.
- **Sign-out doesn't close a register.** Closing is a cashier's deliberate
  action. A later sign-in to the same backend on the same till finds the
  session still open in the same order store and resumes it.

## Job B hand-off

- The count UI replaces `RegisterCountSlot`, passed as `RegisterColumn`'s
  `countSlot` in `RegisterGate` (`components/register.tsx`); nothing else in
  the sale screen changes.
- It reads the same `useRegister().register`, and calls
  `actions.closeSession({ counted })` and `actions.backToSelling()`.
- `softwareVersion` (the app version, stamped on every closure) is already
  passed. Job B adds `varianceThreshold`, `blind` and the closure `labels`
  (`registerName`, `resolveCashierName`) in `RegisterProvider`.

## Known limitations

- One default register per backend, and no server sync: sessions,
  movements and closures stay on the till (TallyUI registers c2).
- Register writes aren't held on sign-out. Unlike a sale's save (ADR 0015's
  holds), a movement write that hangs in storage can be under the order
  store's close when the cashier signs out; that close then waits, as RxDB's
  close waits for every write, until the #85 backstop fails the next open.
- No `requireOpen()` before a card terminal's capture (see above); the
  completion's stamp is the only check after tender start.
- The gate and the stamp read storage. With a dead storage worker, pressing
  Cash or Card, or completing a sale, now reaches the read watchdog's
  "Storage stopped" prompt; before, a completing sale showed "Saving is
  slow…" first (e2e `storage.spec.ts` follows this).
