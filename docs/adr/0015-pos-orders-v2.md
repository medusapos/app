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
  Back. Since the `ce184e6` pin (TallyUI #149) the app passes
  `useOrderOutbox`'s `isStored` to `useSale`. Once that primary-key read
  confirms the order is stored with the same money-bearing content,
  whatever its commandId, the tender also offers Continue. Continue starts
  the next sale, and the outbox sends the stored order.
  - **Requeue.** This covers a sale requeued from Orders while the tender is
    locked. Its stored commandId changes, and the retry now resolves as
    stored: `record` counts the same id and content as stored, never
    overwrites it, and logs the other commandId at warn. Before, the retry
    conflicted and the till stayed on the tender until Sign out or a reload.
  - **Hung save.** Since the `7fb86e5` pin (TallyUI #161), a save still in
    flight and unconfirmed re-asks `isStored` every 5 s. Once the order is
    confirmed stored with the same money-bearing content, the tender offers
    Continue with no tap. A hung save whose insert never landed still
    waits for the save to settle: `isStored` stays false, so there is no
    Continue, and a Retry while it's in flight only rejoins the same save.
    The sale stays locked, and Sign out waits too. A write that stalls while
    reads still work shows only the non-blocking "Saving is slow…" note; the
    blocking storage prompt below needs the reads to go silent too.
  - **Content mismatch.** The same id with other money-bearing content fails
    with `OrderContentMismatchError`. Nothing is overwritten, `isStored`
    logs it at error, and Continue is not offered.
  - **Every sign-out waits for a saving sale** (the #150 and #82 reviews).
    Signing out unmounts the sale and closes the outbox, so a failed save
    that isn't stored would lose its order.
    - `useSale().saving` runs from `complete()` until the save lands. After
      a failed save it runs until Retry stores it or Continue starts the
      next sale; after a hung save, until the save settles or Continue.
    - A save that Continue abandoned can still be in flight (#85 review).
      Its insert runs inside RxDB's `lockedRun`, and RxDB's close waits for
      every one with no time limit. Signing out then would hang the
      outbox's close, and the next sign-in's open would wait on it forever.
      - The count comes from TallyUI: `useOrderOutbox().savesInFlight`
        (#163, since the `2ef19c2` pin), the `record` calls not yet
        settled. `OutboxProvider` passes the outbox through unchanged.
      - The hold lives in `SessionProvider`, as a second hold next to the
        sale hold: the saves hold (`setSavesHold`), driven by
        `OutboxProvider` from `savesInFlight > 0`. It defers every
        sign-out, and a deferred one runs only once both holds are clear.
        `OutboxProvider`'s unmount (LiveTabGate's park, #80's prompt)
        releases it without running a pending sign-out, as the sale
        screen's does. This closes the #85 re-review's gap: the hold used
        to be the sale screen's, so store settings that unmounted that
        screen after Continue (a settings choice, or an unsupported
        backend) let an automatic sign-out run while the save was still in
        flight.
      - Sign out stays disabled while any save is in flight. Continue still
        starts the next sale; only sign-out waits. Sign out's description
        is "An earlier sale is still being saved.", and the same note shows
        visibly under the header. With a sign-out waiting on it, the note
        reads "An earlier sale is still being saved. You'll be signed out
        once it's saved."
      - Backstop: `openOrderStore` waits at most `ORDER_STORE_CLOSE_WAIT_MS`
        (10 s) for the backend's previous store to close, then rejects with
        an ordinary Error, code `ORDER_STORE_CLOSE_TIMEOUT`. That reaches
        #80's blocking prompt (Reload, Report a problem), which shows the
        code, before any sale can be saved. A sale paid during those 10 s
        gets "Orders are not ready." and is lost when the prompt replaces
        the screen. That was already true of any slow open.
    - The sale screen sets a sale hold in `SessionProvider`
      (`lib/session-context.tsx`): `saving`, `receipt`, or none.
    - When the sale screen unmounts for another reason (LiveTabGate's
      park, a blocking storage prompt), the hold is cleared but a pending
      sign-out is not run. Signing out there would tear down under
      LiveTabGate's close. The request stays pending with its token, and
      the next sale screen to mount runs it if the token is unchanged.
    - While the sale is saving, every sign-out request is deferred:
      - the Sign out button, which is also disabled in place;
      - a product replication 401;
      - the capabilities check;
      - the store-settings fetch;
      - a token refresh refused with `invalid_credentials`.
    - Automatic sign-outs (all but the button) also wait for the receipt
      to clear, so the till never jumps to login over a receipt. They run
      after New sale. The receipt hides the header, so there is no Sign out
      button on it; a manual sign-out is available after New sale.
    - One request is kept, with the token it was made under. It is dropped
      if the session was renewed meanwhile (SignInAgain, or a successful
      refresh). While it waits, the screen shows "Signed out after this
      sale is saved", or the earlier-sale note above when only an earlier
      sale's save holds it.
    - This hold is the interim fix. The real fix is a pending completion
      that survives unmount and reload, which belongs to the c2/v3 design.
    - Settings' "‹ Products" goes back to the Products screen under it
      (`router.back()`), and replaces only when opened by URL with no
      history. A replace mounted a second, empty Products screen over the
      sale, hiding it and leaving that screen's Sign out enabled.
  - **Storage.** The storage prompt's Reload covers a stalled or dead storage
    worker, or a worker start failure. Any other order-store open failure
    (e.g. DM4) blocks with its own prompt ("Saved sales can't be opened",
    `orderStoreOpenFailed$`, `apps/expo/components/storage-health.tsx`,
    #80) until Reload, so it no longer passes silently.
    - Since the `de48528` pin (TallyUI #152), a close during
      `addPosOrderCollection` waits for the whole open, and the open then
      rejects with `PosOrderOpenClosedError`. The app doesn't report that
      error to #80's prompt (`lib/outbox-context.tsx`, matched by
      `instanceof`). This is defensive: it covers a close during an open,
      and this app doesn't do that today. `openOrderStore` hands out
      `close()` only once the open resolves, and `closeOrderStores` waits
      on the open. No order would be lost; the outbox would have no store
      until the store key changes or the app reloads, and that open retries.
    - TallyUI #155 (pinned at `03ad08a`) fixed the rare case that remained: a close's 10 s wait
      (`POS_ORDER_MIGRATION_CLOSE_WAIT_MS`) running out mid-migration could
      still let a migration write reach closed storage. Both that open, and
      a close that gives up waiting after the migration, now reject with
      `PosOrderOpenClosedError`. A migration status or record read or write
      that the give-up dropped logs at warn through the new exported
      `posOrdersLogger`, sunk to the console like `saleLogger` and
      `outboxLogger`.
  - A sale that was stored is kept and sent by the outbox. A sale whose
    insert never landed gets no Continue, and is lost with a reload, as
    before this change.
  - `saleLogger`, `outboxLogger` and `posOrdersLogger` warn and error reach the console
    (`apps/expo/lib/logging.ts`, installed in `app/_layout.tsx`). Since
    TallyUI #150 that includes every save failure not yet confirmed stored,
    and a sale screen unmounting with a save pending.
- `useOrderOutbox.recent` (the Orders list and the Needs attention badge)
  re-reads storage on every change since the `de48528` pin (TallyUI #151,
  `watchFresh`). It used to read through a cached RxDB query, which could
  miss an order written while its first read was in flight and stay stale
  until a reload (from the #79 review). A unit test holds that first read
  and records an order during it.
- A sale taken while the outbox is reading its pending sales is sent with no
  restart. A unit test holds that read to hit the race every time. An e2e
  completes a second cash sale as the first one's send is let go. The race
  window is only a few microtasks wide, so the e2e can't hit it on every run.
