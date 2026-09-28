# The Medusa side of the G4 sync experiment

Status: Proposed
Date: 2026-09-29

## Context

TallyUI ADR-067 (Accepted 2026-09-28) makes the WCPOS sync engine (`@wcpos/sync-core`, `@wcpos/sync-engine`) TallyUI's sync engine, and turns each connector into a driver. The TallyUI adoption plan (`docs/plans/sync-engine-adoption.md`, §1e) orders the work WooCommerce app → driver interface (G2) → Medusa driver (P3). **G4 is the gate before G2.** ADR-067 decision 8 and the plan's G4 row say what it must decide:

> keep ADR 0029 decision 5 (the driver materialises the Woo-shaped `payload` at ingest) or make `payload` driver-typed.

The G4 row says a narrow, real Medusa experiment on the seeded demo store decides this, not a paper argument. The experiment has three parts:
- products loaded on demand through `require()`;
- a deletion, and checkpoint recovery after a missed window;
- an offline order replayed, with the server's authoritative totals and revisions coming back.

The report compares the engine's way with what Medusa offers natively, mechanism by mechanism:
- the polled change tick and journal of pointers against server push;
- full-document REST writes against workflow APIs;
- integer-id existence buckets against Medusa ids and timestamps;
- no cross-resource transactions against real ones;
- opaque revisions against typed revisions.

Each gets keep, replace or improve, with numbers.

**Paul's principle** (ADR-067, 2026-09-28): the engine's mechanics are the input and its constraints are not. "The WCPOS sync engine and core may be limited by PHP or server considerations that do not apply to Medusa or Vendure."

**TallyUI ADR-068** adds a named input for G2: the `register.*` commands ride the push side with the command id as `Idempotency-Key`, and each driver maps the `register_*` conflict codes.

This ADR is the **Medusa half** of G4:
- what Medusa 2.21 gives natively, with evidence;
- the numbers measured on the demo store;
- which engine mechanisms the Medusa driver keeps, replaces or drops;
- the plugin surface the experiment needs;
- a direct answer to G4's question, from the Medusa side.

The engine half (running `require()`, the recovery and the offline replay through the engine) is the monorepo's. It is not done here. Every claim about the engine cites the wiki; every claim about Medusa cites source or a measurement.

**How Medusa is reached today (the baseline G4 replaces).** medusapos has no pull surface of its own. TallyUI's `connector-medusa` pulls straight from Medusa's admin and store APIs. It runs **one combined pull replication plus four reconcile runners**, which patch what the product's `updated_at` misses (cited at TallyUI `origin/main` `e151099`, `connectors/medusa/src/`, and confirmed by the TallyUI track):
- **The combined pull** (`index.ts:125-132`, `combinePullAdapters`) has three sub-feeds:
  - products: id-ordered offset pages inside a fixed `updated_at[$gte]` window, 500 per page (`replication/products.ts:52,82-95`);
  - variants, because "a price-only edit bumps the variant's `updated_at` but not the product's" (`replication/variant-feed.ts:26-47`);
  - the id reconcile's re-delivery feed.
- **The four reconcile runners** (`index.ts:136-141`):
  - stock, because "inventory changes never touch the product" (`reconcile/stock.ts:17-21`);
  - ids, for deletions (`reconcile/ids.ts:29-38`);
  - calculated prices, every 30 minutes, because "price-list edits and sale start/end bump no timestamp" (`reconcile/calculated-prices.ts:5-6`);
  - base prices, a nightly backstop (`reconcile/prices.ts:7-8`).

The app wires all of them (`apps/expo/lib/use-replicated-products.ts:131-193`). The push side is the command outbox on `POST /tally/v1/commands`, with the plugin's own idempotency ledger (ADR 0001, ADR 0019).

## Decision

### 1. G4's question: `payload` becomes driver-typed; the Medusa driver does not materialise Woo shapes

From the Medusa side the answer is **driver-typed `payload`**. The engine keeps a small, engine-owned envelope that every driver fills:
- `id` (the opaque `RemoteId`);
- `revision`;
- `deleted`;
- the change marker;
- the promoted query columns (name, SKU, barcode, sort keys), through a driver-declared field map.

`payload` is the driver's own document type, read by the driver's traits (TallyUI ADR-002). The reasons, all on the demo store or in the source:

1. **A Woo product can't hold a Medusa product without loss.** The connector's document (`MEDUSA_PRODUCT_FIELDS`, `replication/products.ts:36-47`) carries:
   - variants embedded in the product, where Woo has a separate variations collection;
   - `prices[]` per currency, plus price-list prices;
   - per-location inventory levels behind inventory items with a `required_quantity` (kits);
   - option values;
   - a context-dependent `calculated_price` per region and sales channel (`pricing/calculated.ts:32-42`).

   Woo's `price`/`regular_price`/`sale_price` and one `stock_quantity` would drop every one of these. A materialised Woo payload would need a second, Medusa-typed side channel for them, which is a driver-typed payload under another name.
2. **The existing Medusa traits already read Medusa shapes.** TallyUI's pos layer reads the catalogue only through traits (TallyUI ADR-002's rule; the Medusa traits are in `connectors/medusa/src/traits/`). Materialising Woo shapes would mean rewriting those traits to read wc/v3 fields and then mapping them back into Medusa ids and prices for `order.create`.
3. **The order write path isn't Woo's.** The engine's Woo write path adopts server money and grafts line ids (wiki `architecture/client/write-path.md`, `architecture/client/ack-identity-and-adoption.md`). WCPOS's money authority is "WooCommerce owns money" (wiki `architecture/decisions/2026-08-23-money-authority.md`). medusapos is the other way round: the till's figures are the fiscal record, and Medusa recomputes totals on read and settles within one minor unit (ADR 0012; `order/dist/utils/transform-order.js:79`). A Woo-shaped order payload would carry Woo's money rules into a backend where they're false.
4. **Revisions are typed in Medusa.** Orders carry an integer `version` (measured: `"version":1` on every seeded order; §Evidence E4). Woo's revision is opaque, and empty on an acked Woo order (wiki `architecture/client/write-path.md`).

What the driver-typed model asks of the engine is G2/G3's cost, not this ADR's to size. The Medusa driver needs:
- `payload: unknown` at the engine boundary, generic in the driver;
- the promoted-column map and conflict-code map declared by the driver;
- the `PosCarrier` over Medusa `metadata`, which ADR 0029 already abstracts.

### 2. Mechanism by mechanism

| WCPOS engine mechanism | Why WCPOS has it | Medusa driver | Medusa primitive and reason |
|---|---|---|---|
| **Mutation queue**: durable, `Idempotency-Key` = mutation id, drain lease, dead letters, coalesce/annihilate | Flaky tills and several windows; not a WordPress limit (wiki `client/mutation-queue-concurrency.md`) | **Keep** | The plugin already has the server half. `POST /tally/v1/commands` claims each command id in a ledger with a payload fingerprint and returns `duplicate` on replay or `idempotency_mismatch` on new bytes (`execute.ts:32-51`, ADR 0001). Medusa's own workflow idempotency isn't a substitute (see E2.7): the command id stays the key. |
| **Revisions**: `If-Match` = base revision, 409/412/428 | Woo's revisions are opaque, and bare for acked orders (wiki `client/write-path.md`) | **Replace with typed revisions** | Orders: Medusa's integer `order.version` (measured, E4). Catalogue: the POS never writes products (`replication/products.ts:57-59`). Customers: no version column, so the revision is the journal sequence of the row's last change (§3). |
| **Conflict states**: `write-conflict`, `retry-with-server-base`, `requeue-rebuilt`, `discard`; catalogue reject-revert | Generic engine logic (wiki `client/dead-letter-recovery.md`, `client/catalog-write-safety.md`) | **Keep; driver maps codes** | The plugin answers business refusals per command in a 200 (`invalid_payload`, `store_configuration`, `idempotency_mismatch`, `unsupported_version`, the five `register_*` codes; `process.ts:52-113`, ADR 0019). The driver maps them onto the engine's conflict states (ADR-068 decision 12). |
| **Money authority**: the server's totals win, and a divergence is a failed invariant | Woo's aggregates are read-only and recomputed (wiki `decisions/2026-08-23-money-authority.md`) | **Replace (inverted)** | ADR 0012: the till's totals are the fiscal record, and Medusa's `raw_total` is a recomputed view. The ack returns Medusa's figures as a reconciliation view, and the driver declares `moneyAuthority: 'till'`. |
| **Demand-driven partial replicas**: require plane, lanes, coverage | Big catalogues on small devices (wiki `client/require-plane-outcomes.md`, `client/census-and-coverage.md`) | **Keep** | Medusa list routes already serve demand: `id[]`, `q`, `order` and `limit`/`offset`, with no cap on `limit` (`medusa/dist/api/utils/validators.js:47-78`; 5,000 honoured, E1). |
| **Census**: server count per collection (`X-WP-Total`) | WordPress gives counts only in a header, and some need their own route (wiki `client/census-and-coverage.md`) | **Replace** | Every Medusa list response carries `count` (E1). The one limit: the store API counts only what the sales channel lists (1,956 of 2,011 products, E1). |
| **Change signal**: polled `changes/tick`, ETag/304, jitter, idle decay | "No push" is **inferred**, since no wiki page states it (wiki `client/change-signal.md`). ADR-067 names the polled tick as a PHP constraint. | **Replace with push, plus a slow poll fallback** | Medusa has an event bus and subscribers, but its only client push is SSE for workflow-execution progress; there's no data-change stream (E2.1, E2.2). The plugin adds an SSE stream that sends `{epoch, head}` whenever the journal head moves. The engine's tick becomes a fallback poll, every 5 minutes (a proposal) or on reconnect. A tick costs 45 ms here, and 41 ms of that is round trip (E5). The Express ETag doesn't revalidate (E6), so the fallback tick carries its own 304 on `since == head`. |
| **Journal of pointers**: `sequence`, `object_type`, `object_id`, `deleted`, `revision` | Written from WP hooks, re-pulled by id (wiki `plugin-free/v2-change-log-and-integrity.md`) | **Keep, fed by Medusa events** | Not kept because the server can't push, but because an offline till needs a replayable, gap-free log, and push alone can't recover a missed window. `updated_at` can't replace it: children don't bump the product (connector, above), the inventory route rejects `updated_at` filters (E3), and bulk writes tie at the millisecond (E4). Subscribers on product, variant, inventory-level, customer and order events write one pointer row per affected document in a plugin table with a `bigserial` sequence (§3). |
| **Checkpoints**: `{since, head, horizon, epoch}`, backlog guard, cursor persisted after success | Retention purge and table re-creation (wiki `plugin-free/v2-change-log-and-integrity.md`, `client/change-signal.md`) | **Keep as is** | The same shape over the plugin journal. The epoch is minted when the journal table is created, and the horizon tracks retention. |
| **Existence audit**: integer-id buckets, xor64 digest gate, two drills per tick | Sparse `wp_posts` ids, hook-bypassing writes (wiki `client/existence-audit-politeness.md`) | **Replace buckets; keep the gate** | Medusa ids are ULID strings (`prod_01M3…`), so integer ranges don't apply (ADR 0029 decision 2 already makes this a driver capability). The plugin buckets by `hash(id) mod 256` and digests `(id, revision)` per bucket in SQL. A full client-side manifest is also cheap here: all 2,011 product ids with `updated_at` in one 144 ms, 163 KB request (E5). The audit remains the backstop for events lost between commit and subscriber (E2.1). |
| **Tombstones** | The journal's `deleted` flag (wiki `plugin-free/v2-change-log-and-integrity.md`) | **Keep, via events** | `product.deleted`, `product-variant.deleted`, `customer.deleted` and `inventory-level.deleted` exist (`utils/dist/core-flows/events.js:548,587,108,1112`). Medusa soft-deletes (E2.4), but the admin list routes are no way to find deletions (E3), so the journal row is the tombstone. |
| **Server politeness**: per-lane request bounds, pressure ladder (429, 5xx, median over 2 s), maintenance defers | "Shared PHP hosting: a handful of PHP-FPM workers, a full WordPress bootstrap per REST hit" (wiki `decisions/2026-08-11-sync-engine-politeness-invariant.md`) | **Keep the ladder; relax the budgets with numbers** | The ladder is backend-agnostic and cheap to keep: the demo runs on a shared VPS, and one Node process serves both admin and POS. The per-tick budgets were sized for PHP-FPM. Medusa serves a 5,000-row id manifest in 0.5 s and a 100-product page in 0.46 s (E5), so the Medusa driver declares its own `maxRequestsPerTick` from G4's measurements, not Woo's. |
| **Full-document REST writes** | wc/v3 is a document API | **Replace with commands** | The till never writes catalogue. Sales and register facts go as commands (`order.create` v1–3, `register.*` v1) into plugin workflows (`workflow.ts:74-130`). A command states intent, and the server runs the Medusa workflow. |
| **Cross-resource transactions** | WordPress has none | **Partly replace** | Inside a plugin module, one service call is one Postgres transaction (ADR 0019: row locks, partial unique indexes). Across Medusa modules, a workflow is a saga with compensation, not one transaction (E2.8). So the ledger lease (ADR 0001), the per-order advisory lock (`execute.ts:57-60`) and the `metadata.tally_client_id` dedupe stay. |
| **Web multi-tab write leader** | Web opens several tabs on one database (wiki `client/mutation-queue-concurrency.md`) | **Drop** | Single-instance storage: one tab, one database (Paul, 2026-09-24; WCPOS v1.11.0 storage notes). |
| **GMT bare-date format, `?rest_route=` transport, `X-WCPOS-Store`** | WordPress wire quirks (wiki `client/gmt-dates-and-reconciliation.md`, `decisions/2026-08-21-rest-route-transport-mode.md`) | **Drop** | Medusa returns ISO-8601 `Z` timestamps (E4). Routes are plain paths. Store scope is the sales channel and publishable key. |

### 3. The plugin surface for the driver

Auth is unchanged for every route: `authenticate('user', ['bearer', 'session'])` and the `tallyCors` middleware (`packages/medusa-plugin/src/api/middlewares.ts:18-31`). The store API's calculated prices need the publishable key (`pricing/calculated.ts:18-23`). Every new route is additive and gated by a capability in `/tally/v1/info`.

**Already there:**

| Route | Shape (sketch) | Role for the driver |
|---|---|---|
| `POST /tally/v1/commands` | `X-Tally-Protocol: 1`; `{ commands: CommandEnvelope[] }`, at most 50 and 1 MB → `{ results: [{ id, status: applied\|duplicate\|rejected, error?, serverRefs?, register? }] }`; 409 `in_progress`; 503 `transient` (`commands/route.ts`, `process.ts:17-116`, `middlewares.ts:21-27`) | The push side. The envelope `id` is the `Idempotency-Key`. `order.create` v1–3 and the five `register.*` v1 commands. |
| `GET /tally/v1/info` | `{ contracts: { 'order.create': [1,2,3], register: [1] } }` (measured on the demo; `info/route.ts:5-7`) | Capabilities. Gains `sync: [1]` and `push: ['sse']`. |
| `GET /tally/v1/registers/{id}` | Register state, with the open session's `expected` and `salesCount` (`registers/[id]/route.ts`) | Register reads (ADR 0019, P2). Not a replicated collection. |

**New for G4** (sketch; version 1 of a `sync` contract):

| Route | Request | Response | Fed by |
|---|---|---|---|
| `GET /tally/v1/changes` | `since=<seq>&limit=<n≤1000>`, plus optional `collections=products,customers,orders` | `{ epoch, head, horizon, changes: [{ seq, collection, id, op: 'upsert'\|'delete', revision }], more }`. A `since` below `horizon`, or a different `epoch`, answers `410 { code: 'cursor_expired', epoch, head }`, and the engine then takes its backlog-guard path. | The `tally_change` table (below) |
| `GET /tally/v1/changes/tick` | `since=<seq>&epoch=<e>` | `304` when `since == head`, otherwise `{ epoch, head, horizon }` | Same table |
| `GET /tally/v1/changes/stream` | SSE with `Accept: text/event-stream`. The browser `EventSource` can't set headers, so the bearer token goes in the query string or a session cookie. | `event: head` `data: {epoch, head}` on each commit, coalesced to at most 1 per second, and a `: ping` every 25 s. The client re-ticks on reconnect. | An in-process listener on journal inserts. With more than one server instance, Redis pub/sub or Postgres `LISTEN/NOTIFY`. |
| `GET /tally/v1/digests/{collection}` | – | `{ count, buckets: [{ b, n, digest }] }`, with 256 buckets by `hash(id)`, `digest = xor64(hash(id‖revision))` | SQL over the source tables and the journal revision |
| `GET /tally/v1/digests/{collection}/{bucket}` | – | `{ ids: [{ id, revision }] }` | Same |

**The journal table** (`tally_change`, in a new `tally_sync` module): `seq bigserial primary key`, `collection`, `object_id`, `op`, `created_at`, and an index on `(collection, object_id)`. The revision is the `seq` of the object's latest row. Retention purges superseded rows and advances `horizon`. The subscribers:

| Medusa event (`utils/dist/core-flows/events.js`) | Journal rows |
|---|---|
| `product.created/updated/deleted` (554-588) | `products:{id}` |
| `product-variant.created/updated/deleted` (515-549) | `products:{product_id}`, since variants live inside the product document |
| Module events `pricing.price.created/updated/deleted` and `pricing.price-set.*` (`utils/dist/pricing/events.js:8-9`; internal, E2.1) | Resolved price → price set → variant (`product_variant_price_set` link) → `products:{product_id}`. This covers price edits on any route, including ones that bypass the variant workflow. |
| `inventory-level.created/updated/deleted` (1071-1113) and `inventory-item.*` (1026-1066) | Resolved to `products:{product_id}` through the variant–inventory-item link. The payload carries `order_id` when an order flow caused it (1094-1095). |
| `product-option.*`, `product-option-value.*`, `product-tag/type/category/collection.*` | The affected products, or their own reference collections |
| `customer.created/updated/deleted` (75-109) | `customers:{id}` |
| `order.placed/updated/completed/canceled/archived`, `order-edit.confirmed` (114-309) | `orders:{id}`, for the till's own order history |
| Module events `pricing.price-list.*` (internal) | Every product with a price in that list |
| **No event at all when time passes.** A price list's `starts_at`/`ends_at` boundary or a sale ending writes nothing. | A plugin scheduled job every minute (a proposal) journals the products of every price list whose `starts_at` or `ends_at` fell since its last run. Together with the price events above, this replaces the connector's 30-minute calculated-price pass and nightly base-price pass. |

**Fetch by id and browse windows stay on Medusa's own routes for G4.**
- `/admin/products?id[]=…&fields=<MEDUSA_PRODUCT_FIELDS>`: 100 full documents in 468 ms (E5). The URL is 4.4 KB for 100 ids, within Node's 16 KB limit (`reconcile/ids.ts:10-14`).
- `/store/products?id[]=…&region_id=…` for calculated prices: 100 products in 197 ms (E5).
- A plugin `GET /tally/v1/products?ids=` that does both in one `query.graph` call is an optimisation for after G4, and only if the two-request fetch shows up in the numbers.

**What the driver stops doing.** The combined pull (products, variants, the id re-delivery feed) and the four reconcile runners (stock, ids, calculated prices, base prices) collapse into one journal cursor and one digest audit. On the demo, one full pass of the current reconcile runners (not counting the product and variant feeds) costs about 35 requests, from the counts in E1:
- ids: 3;
- stock: 6;
- calculated prices: 20;
- base prices: 6.

An idle store costs one SSE connection and no requests.

## Evidence

### E1–E6: measured on the demo store

Measured 2026-09-29 against `https://mpdemo.213.239.218.130.sslip.io` (Medusa 2.21.0, plugin with `register: [1]`), from the Mac mini. The probe is `/Users/claude/.claude/jobs/653cb62e/tmp/adr0020/probe.mjs` (run by `probe.sh`; raw output in `probe-output.txt`). It makes one auth POST and GETs only; timings are the median of 3 runs, 5 for the tick. The network round trip is about 41 ms (`/health` 41 ms, `/tally/v1/info` 41 ms median).

**E1: page sizes and counts**

| Route | Default `limit` | `limit=5000` | `count` |
|---|---|---|---|
| `/admin/products` | 50 | honoured (2,011 returned) | 2,011 |
| `/admin/product-variants` | 50 | honoured (5,000 returned) | 5,662 |
| `/admin/inventory-items` | 20 | honoured (5,000 returned) | 5,260 |
| `/admin/orders` | 15 | honoured (301 returned) | 301 |
| `/admin/customers` | 50 | honoured | 2,083 |
| `/store/products` (publishable key) | 50 | honoured | 1,956 (sales-channel scoped) |

There is no maximum: `createFindParams` sets only a default (`medusa/dist/api/utils/validators.js:59-67`). The "1,000 Admin API list limit" in the connector's comments (`reconcile/ids.ts:7`, `reconcile/stock.ts:6`) is the connector's own choice, not Medusa's.

**E3: `updated_at` filters**

| Route | `updated_at[$gt]` | `updated_at[gt]` (no `$`) |
|---|---|---|
| `/admin/products` | works (1 of 2,011 after the pass mark) | **silently ignored** (2,011) |
| `/admin/product-variants` | works (7) | silently ignored (5,662) |
| `/admin/orders` | works (1) | silently ignored (301) |
| `/admin/customers` | works (0) | silently ignored (2,083) |
| `/admin/inventory-items` | **400** "Unrecognized fields: 'updated_at'" | 400 |
| `/store/products` | works (a future bound gives 0) | – |

The inventory route's validator is `.strict()` and has no date fields (`medusa/dist/api/admin/inventory-items/validators.js:8-33`). The operator map accepts only `$`-prefixed keys (`medusa/dist/api/utils/validators.js:80-107`), so `gt` parses to an empty filter.

**E3b: soft-delete visibility.** `with_deleted=true` is accepted on every list route (`validators.js:71-76`). On the demo it returned the live count (products 2,011, variants 5,662, customers 2,083, orders 301), because the demo has no deleted rows to show. `deleted_at[$gt]=2000-01-01` on `/admin/orders` returned all 301 orders with `deleted_at: null`, so orders ignore a `deleted_at` filter. `/admin/inventory-items` rejects `deleted_at` with 400. **Deletions can't be read reliably from list routes; the journal is the source of tombstones.** Confirming `with_deleted` against a real deleted product needs a write, and that's G4's to run on the Mac mini dev store, not the shared VPS.

**E4: timestamp precision and revisions.** API timestamps are ISO-8601 with milliseconds (`2026-09-28T18:34:05.085Z`). The columns are `timestamptz`, but the app sets the value from a JS `Date` on its own clock (E2.4), not the database's. Bulk writes tie: 4 of the 5 most recent products share `…05.085Z`, and 2 of 3 variants share `…05.176Z`. A millisecond `updated_at` cursor therefore needs `$gte` and an id tie-break, as the connector already does (`replication/products.ts:86-94`). Orders carry `version: 1` (integer).

**E5: response times**

| Request | Median | Size |
|---|---|---|
| Change tick: `/admin/products?limit=1&order=-updated_at&fields=id,updated_at` | 45 ms (network about 41 ms) | 129 B |
| 100 products, full POS fields | 460 ms | 869 KB |
| 500 products, full POS fields | 2,346 ms | 4.0 MB |
| 100 products, default fields | 302 ms | 743 KB |
| 100 products by `id[]`, full fields | 468 ms | 869 KB |
| Manifest: 2,011 product `id,updated_at` in one page | 144 ms | 163 KB |
| Manifest: 5,000 variant `id,updated_at,product_id` | 473 ms | 655 KB |
| 5,000 inventory items with levels | 638 ms | 780 KB |
| 100 orders, default fields | 410 ms | 905 KB |
| 100 store products with `calculated_price` | 197 ms | 238 KB |
| `/tally/v1/info` | 41 ms | 53 B |

A full product document is about 8.7 KB. A 2,011-product first sync at 500 per page is 5 pages and about 12 s of server time, sequentially.

**E6: push surfaces and conditional GET.**
- `GET /admin/notifications` is a JSON list (`notifications, count, offset, limit`), not a stream.
- `/admin/events`, `/admin/stream` and `/tally/v1/events` return 404.
- `/admin/feature-flags` shows `index_engine: false`, so the Index module is off on the demo.
- Responses carry a weak Express ETag (`W/"81-…"`), but `If-None-Match` still returns 200, so there's no 304 revalidation today.

### E2: Medusa 2.21 source

Paths are under `dev/medusa-store/node_modules/@medusajs/` at 2.21.0. This worktree has no install, so they were read from the identical 2.21.0 install in the sibling medusapos worktree `agent-a3059f1c13197be8c`.

**E2.1: events, and when they are delivered.** There are two layers.
- **Workflow events.** `emitEventStep` tags each message with the run's `eventGroupId` (`core-flows/dist/common/steps/emit-event.js:50-63`). Every run gets a group id (`workflows-sdk/dist/helper/workflow-export.js:107`). The group is released only when the workflow finishes, and cleared if it fails or reverts (`workflow-export.js:251-289`), so a subscriber never sees an event for a rolled-back write.
  - The names are in `utils/dist/core-flows/events.js`:
    - `product.*`: 565/576/587;
    - `product-variant.*`: 526/537/548;
    - `inventory-item.*`: 1039/1052/1065;
    - `inventory-level.*`: 1084/1099/1112, whose payload carries `order_id` when an order flow caused it (1094-1095);
    - `customer.*`: 86/97/108;
    - `order.*`: 126-258.
  - They are emitted from:
    - `core-flows/dist/product/workflows/update-products.js:332`, `create-products.js:193`, `delete-products.js:106`, `update-product-variants.js:188`;
    - `inventory/workflows/update-inventory-levels.js:41`, `batch-inventory-item-levels.js:64,67`;
    - `cart/workflows/complete-cart.js:535` (`order.placed`);
    - `create-fulfillment.js:405` (`inventory-level.updated`).
- **Module entity events** (`<module>.<entity>.<action>`, payload `{id}`). MikroORM hooks emit them for every create, update, upsert and delete (`utils/dist/modules-sdk/create-medusa-mikro-orm-event-subscriber.js:29-38`). A soft delete becomes `deleted` and a restore becomes `restored` (`utils/dist/modules-sdk/medusa-service.js:247-281`).
  - They are sent `internal: true` (`medusa-service.js:317-328`). On Redis they get the lowest priority (`event-bus-redis/dist/services/event-bus-redis.js:154`), and they carry the same `eventGroupId` (`utils/dist/event-bus/build-event-messages.js:22-23`).
  - **This is where price changes surface.** The pricing entities are listed in `utils/dist/pricing/events.js:8-9`, and the pricing module is decorated with `@EmitEvents` (`pricing/dist/services/pricing-module.js:891-899`). The Index module itself listens to `pricing.price.updated` (`index/dist/utils/default-schema.js:29`). Inventory emits on `updateInventoryLevels_` and `adjustInventory` (`inventory/dist/services/inventory-module.js:572-586`).
  - **No workflow-level price or price-list event exists** in `events.js`.
- **Subscribers** are a default handler plus `config = { event: string | string[] }` (`framework/dist/subscribers/subscriber-loader.js:60-86`). The local bus also supports a `*` subscriber (`event-bus-local/dist/services/event-bus-local.js:53,71-72`).
- **Delivery gap.** The bus is in-process (local) or Redis. Nothing ties an event's delivery to the database commit durably, so a process crash after commit and before release loses the event. That's why the digest audit stays.

**E2.2: push.** Medusa's only server push is SSE for workflow-execution progress:
- `medusa/dist/api/admin/workflows-executions/[workflow_id]/subscribe/route.js:9-13,26-41`, which sets `Content-Type: text/event-stream`;
- the same shape at `…/[transaction_id]/subscribe/route.js:10`.

There is no websocket, `socket.io` or data-change stream in `medusa/dist`, `framework/dist`, `core-flows`, `utils` or `workflows-sdk`. The admin dashboard itself polls (`dashboard/dist/app.js:115521`, `refetchInterval: 6e4`). So a POS change stream is plugin work, but Medusa's own SSE route shows the HTTP layer holds such streams.

**E2.3: hooks.** `createHook` is at `workflows-sdk/dist/utils/composer/create-hook.js:44-64`. The product hooks are:
- `productsCreated` (`create-products.js:196`);
- `productsUpdated` (`update-products.js:335`);
- `productsDeleted` (`delete-products.js:109`);
- `productVariantsCreated` and `productVariantsUpdated` (`create-product-variants.js:213`, `update-product-variants.js:191`).

`complete-cart` has `orderCreated` (`:583`). The inventory workflows have no hooks. Hooks run inside the workflow, so a hook writing the journal row would commit with the change. Subscribers are preferred anyway, because they cover the module events (prices) that no hook sees.

**E2.4: `updated_at`, `deleted_at` and soft delete.**
- Every DML model gets `created_at`, `updated_at` and a nullable `deleted_at` (`utils/dist/dml/helpers/entity-builder/create-default-properties.js:5-10`), with indexes filtered on `deleted_at IS NULL` (`define-property.js:73-85`).
- `updated_at` is `timestamptz`, set by the app with `onUpdate: () => new Date()` (`define-property.js:18,62-72`). That gives millisecond precision from the app's clock, as E4 shows.
- The delete steps soft-delete:
  - `product/steps/delete-products.js:12`;
  - `delete-product-variants.js:12`;
  - `inventory/steps/delete-inventory-items.js:23`;
  - `delete-inventory-levels.js:12`;
  - `customer/steps/delete-customers.js:12`;
  - `price-list/steps/remove-price-list-prices.js:17`;
  - `delete-price-lists.js:12`.

  A product delete cascades to its variants and images (`product/dist/models/product.js:149-151`).
- `with_deleted` becomes `withDeleted` on the query (`framework/dist/http/utils/get-query-config.js:85,101`; `validate-query.js:87`).
- Which list validators accept date filters: products, variants, store products and customers take all three; orders take `created_at` and `updated_at` only; inventory items take none, and the schema is `.strict()`; price lists take only `starts_at`/`ends_at`. Paths:
  - `medusa/dist/api/admin/products/validators.js:20-38`;
  - `admin/product-variants/validators.js:16-22`;
  - `store/products/validators.js:24-39`;
  - `admin/orders/validators.js:27-42`;
  - `admin/customers/validators.js:11-39`;
  - `admin/inventory-items/validators.js:7-33`;
  - `admin/price-lists/validators.js:16-23`.
- Pagination is offset only. `order` is one field (`get-query-config.js:63-73`), and there is no keyset or cursor pagination in the API.
- **A price or stock change doesn't bump the product.** The product model has no price or inventory relation (`product/dist/models/product.js:18-148`). Prices live in the pricing module (`pricing/dist/models/price.js:10-30`) and stock in inventory (`inventory/dist/models/inventory-level.js:8-20`), joined by link tables.

**E2.5: Index module.**
- It's behind `index_engine`, off by default (`medusa/dist/feature-flags/index-engine.js:3-8`) and off on the demo (E6).
- When it's on, `/admin/products` uses `query.index` only when filters are present, and not for tags, categories or options (`admin/products/route.js:12-23,65-72`), and it returns an `estimate_count`.
- Its default schema stores `updated_at` on Product only, not on variants or prices (`index/dist/utils/default-schema.js:6-37`).
- It can't be the existence manifest or the change feed. `query.graph` with `fields: ['id','updated_at']`, or the list route with a large `limit`, is (E5: 144 ms for 2,011 products).

**E2.6: locking.**
- `acquireLockStep` polls every 0.3 s until its timeout, and compensation releases the lock (`core-flows/dist/locking/steps/acquire-lock.js:18-65`).
- There are in-memory, Postgres advisory and Redis providers (`locking/dist/providers/in-memory.js:6`; `locking-postgres/dist/services/advisory-lock.js:28,50-80`).
- `completeCartWorkflow` uses it (`complete-cart.js:309`). The plugin uses `Modules.LOCKING` for inventory take-back (`workflow.ts:50,60`) and its own advisory lock per order (`execute.ts:57-60`).

**E2.7: workflow idempotency.**
- Workflow runs accept `idempotent`, which uses "the transaction ID as the key to ensure only-once execution", plus `store` and `retentionTime` (`orchestration/dist/transaction/types.d.ts:114-129`).
- The default transaction id is `auto-<ulid>` (`workflow-export.js:105-106`), and Medusa's own admin routes pass none (`admin/products/[id]/route.js:36-42`).
- Even `completeCartWorkflow` runs with `idempotent: false` and dedupes through the `order_cart` link plus a lock (`complete-cart.js:303-348`).
- So workflow idempotency is bounded by `retentionTime` and the workflow store, and it has no payload fingerprint. The plugin ledger (ADR 0001) stays the idempotency authority.
- Whether any Medusa route reads an `Idempotency-Key` header was **not verified**: the source grep was cut off. It doesn't matter here, because the plugin defines its own.

**E2.8: transactions.**
- `@InjectTransactionManager` reuses a transaction already in the context, and otherwise opens one per module method (`utils/dist/modules-sdk/decorators/inject-transaction-manager.js:15-45`).
- Each module has its own manager, so a workflow's writes across modules aren't one transaction. Consistency comes from step compensation.
- A plugin module's own tables do get real transactions. `tally_register` relies on this (ADR 0019), and the journal can too.

### Baseline cited from TallyUI

These connector citations, and those in the Context section, describe TallyUI's code at `origin/main` `e151099`. The TallyUI track confirmed them on 2026-09-29, correcting the runner count to one combined pull (three sub-feeds) plus four reconcilers. The handoff copies of ADR-067, ADR-068 and the adoption plan (`~/agent/handoff/tallyui-*.md`) are the TallyUI inputs.

Cited at `origin/main` `e151099`:
- `connectors/medusa/src/replication/products.ts:22-137`: the offset-in-window pull, and "Medusa 2.21 honours only the operator form; `updated_at[gte]` is silently dropped" (line 93), confirmed by E3;
- `replication/variant-feed.ts:26-47`: price-only edits bump the variant, not the product;
- `reconcile/stock.ts:17-21`: inventory changes never touch the product;
- `reconcile/calculated-prices.ts:5`: price-list edits and sale start/end bump no timestamp.

## Consequences

- **G4's answer from Medusa is "driver-typed `payload`",** backed by the data a Woo shape would lose (Decision 1). The monorepo half of G4 still has to run the three experiments through the engine. This ADR gives it the server surface and the numbers to beat.
- **The plugin grows a `tally_sync` module:** the journal table, subscribers, one scheduled job, and four read routes plus SSE. All are additive and gated by `contracts.sync` in `/tally/v1/info`. The command endpoint is unchanged, and `order.create` and `register.*` keep their ledger.
- **The connector's combined pull and four reconcile runners retire when the driver lands (P3).** They stay in service for testers until then (ADR-067 decision 7).
- **A lost event is caught by the digest audit, not by the journal.** Medusa's event bus releases events after the workflow finishes (E2.1), so a crash between commit and subscriber loses the pointer. The audit's cadence bounds how long that lasts. G4 measures it.
- **Politeness budgets become per driver.** Woo's PHP-sized ceilings don't bind Medusa. The pressure ladder stays for the shared VPS.
- **Candidates for WCPOS v2** (ADR-067: "an improvement proven on Medusa … is a candidate for WCPOS v2"):
  - a push-hinted tick;
  - hash buckets instead of id ranges, for any backend with non-integer ids.

  Both go to Paul with G4's numbers, not before.
- **The SSE route is the only long-lived connection this plugin serves.** Its per-till cost (one socket and a 25 s ping) must be measured on the demo before any tester uses it. Traefik on the VPS must not buffer `text/event-stream`. That's a read-only check the front desk makes; this worker changes nothing on the server.

## Open questions

1. **For TallyUI and the monorepo:** does the engine accept a driver-typed `payload` with a driver-declared promoted-column map, or does G2 want a thin engine-owned projection alongside a typed payload? This ADR assumes the first.
2. **Money authority:** G4's replay step expects "the server's authoritative totals". On Medusa the till's totals are the fiscal record (ADR 0012). Should the engine's money-authority invariant become a driver capability (`'server'` for Woo, `'till'` for Medusa), with Medusa's figures shown as a reconciliation view as ADR-068 decision 13 does for registers?
3. **Internal module events as a feed:** price changes reach subscribers only as `internal: true` module events, at the lowest Redis priority (E2.1). Is their latency acceptable for "a price edited in the admin reaches the till within a tick" (plan P3)? G4 measures this on the Mac mini dev store, since a write is needed. The demo on the shared VPS gets no writes.
4. **SSE on native:** the engine's React Native hosts need an SSE client (`EventSource` isn't built into React Native). Is a push-hinted tick worth a dependency, or should native keep the polled tick with jitter and idle decay, and web use SSE?
5. **Order history as a collection:** should the till replicate its own orders (`orders:{id}` journal rows, revision = `order.version`), or keep ADR-024's outbox view until an order-edit command exists?
6. **Customers:** customers have no version column. Is the journal `seq` acceptable as their revision for `If-Match` on a future `customer.update` command, or should the plugin add a `tally_revision` in customer metadata?
7. **Index module:** `index_engine` is off on the demo (E6). Does TallyUI want the driver to rely on `query.index` for filtered browse windows on linked data (for example stock by location), or stay on `query.graph` and list routes, which is what this ADR assumes?
