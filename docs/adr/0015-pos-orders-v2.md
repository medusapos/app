# The till's order store moves to pos_orders schema v2

Status: Accepted
Date: 2026-09-27

## Context

TallyUI registers c1a (#144) moved `pos_orders`, the store of the till's
unsent sales, to schema version 2. Version 2 adds three optional fields and
changes nothing else:

- `lateSessionId` (TallyUI ADR-032, a sale taken after its register session
  closed);
- `display` and `taxByRate` (TallyUI ADR-065), which nothing writes yet.

Its migration strategies are identities from version 0 and from version 1.
The pin (`8e86d7a`) also brings three more changes:

- #145, which makes `useSale().complete()` idempotent for one tender;
- #143, `useRegisterSession`, which this app doesn't use yet;
- #146, which makes the outbox drain read storage fresh.

## Decision

- **The app adopts schema v2.** It opens `pos_orders` only through
  `addPosOrderCollection`, in `openOrderStore` and in the legacy Dexie
  carry-over, as it has since #68. That call migrates a store at version 0
  or 1 to version 2 on the first open. It resolves only once no older order
  is left, rejects with DM4 after the migration has stopped, and never
  deletes an order. No app code changes for v2 beyond comments: the
  `PosOrder` type only gained optional fields.
- **The late-sale changes are inert here.** The app passes no `session` to
  `useSale`, so nothing sets `lateSessionId`, no `late-sale` register fact is
  recorded, and `needsAttention` and `OrdersList` select and show the same
  orders as before.
- **`complete()` idempotency is live here.** A retry after a failed save
  hands over the same order, a double tap builds one order, and
  `useOrderOutbox.record` counts an order already stored under the same
  `commandId` as stored. While a save is pending, the tender can't be
  changed or left. "Back" shows "This sale is being saved. Retry to finish
  it.", and "Complete sale" retries.
- **Rolling back to an older build is unsupported.** TallyUI's integration
  guide (`apps/web/content/docs/integration.mdx`, line 32 at `8e86d7a`)
  says: "Rolling a till back to a build with an older `pos_orders` schema
  version, then upgrading it again, is unsupported. For example, a till that
  goes from version 1 back to version 0 and then on to version 2 holds two
  older versions at once. Its first `addPosOrderCollection` then rejects
  with DM4, and the next call migrates the rest. No order is lost."
  - An older build opens its own schema version and doesn't see the sales
    stored at version 2, so they wait until the till is upgraded again.
  - TallyUI's `open.ts` names the rare case where a rollback is worse:
    "after a rollback, an older build's one-time carry-over (for example
    medusapos's Dexie import …) can bulk-insert an older state of order A
    into an empty older version while the current version holds A as sent.
    This overwrite then makes A pending again, and it is sent twice; the
    server's commandId idempotency is what stops a double charge."
- **The outbox drain reads storage fresh (TallyUI #146, pin `8e86d7a`).**
  RxDB 16.21.1 caches a query's result. A sale inserted while the outbox's
  pending read was in flight was missing from that cached result for good,
  so it sat "Waiting to sync" until the app restarted. `createOrderOutbox`
  now reads and counts past the cache (`readFresh`, `countFresh`), with no
  API change, so this app changes only its pin.
- **The E2E seed hooks write faithful v0 and v1.** They are debug-build only,
  through `exposeE2eHook`. Version 1 is version 2 minus `lateSessionId`,
  `display` and `taxByRate`, with its identity strategy. Version 0 is
  version 1 minus `sessionId`. The unit tests build the same schemas.
  - `SeedV0Order` and `SeedV1Order` seed the SQLite store.
  - `SeedLegacyOrder` seeds the pre-SQLite Dexie store, and stays at v0,
    since every pre-SQLite build wrote v0.

## Consequences

- A till's first open on this build migrates its unsent sales to version 2.
  Unit tests (memory storage) and the Chromium e2e (SQLite) cover it from
  v0 and from v1, and from the legacy store. Each shows the sale waiting,
  then syncing once.
- After a failed save, the tender stays locked. "Complete sale" (or
  "Payment approved on terminal") retries with the same ids, and there is no
  Back. The storage prompt's Reload appears only for a stalled or dead
  storage worker or a worker start failure. After any other open failure
  (e.g. DM4), and after a sale is requeued from Orders while the tender is
  locked (its stored commandId changes, so the retry conflicts), the till
  stays on the tender until Sign out or a browser reload.
  - A sale that was stored is kept and sent by the outbox.
  - A sale whose insert never landed is lost with the reload, as before this
    change.
  - A TallyUI follow-up is to offer an explicit way out once the stored order
    is confirmed (from the #79 review).
- `useOrderOutbox.recent` (the Orders list and the Needs attention badge)
  still reads through a cached RxDB query, so right after the store opens it
  can briefly show a stale list until the next change or a reload. This is
  display only: the outbox sends from fresh reads. A TallyUI follow-up
  (from the #79 review).
- A sale taken while the outbox is reading its pending sales is sent with no
  restart. A unit test holds that read to hit the race every time. An e2e
  completes a second cash sale as the first one's send is let go. The race
  window is only a few microtasks wide, so the e2e can't hit it on every run.
