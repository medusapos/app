# G4 spike: Medusa events against writes

Measured on 2026-09-29 for ADR 0020, Ruling Q3: before the plugin journal depends on Medusa's events, count them against writes and measure how late they arrive. Numbers only; no plugin code came out of this.

## The answer in short

- **Every write that changed a product-document row emitted at least one event, with three exceptions.**
  1. **A price-list update or status change emits nothing.** 0 events over 7 writes, on both buses. A manual `psql` check after the runs (not recorded by the harness) showed that the title, `starts_at` and `ends_at` changed in the database and that `price_list.updated_at` moved. The status change wasn't read back.
  2. **On the Redis bus, a module write from a process with no matching subscriber is dropped at the emitter.** 0 of 3 direct writes from a `medusa exec` child reached the server. With a `"*"` subscriber loaded in the child, all 3 arrived.
  3. **On the local bus, events never leave the writing process.** The same 3 direct writes reached the child's own subscriber and never the server.
- **Workflow events alone are not enough.** A write that bypasses the workflows (a direct module call) emits only module entity events (`pricing.price.updated`, `inventory.inventory-level.updated`, `product.product-variant.updated`). The journal must subscribe to those.
- **Add or remove a product on a sales channel through the sales-channel route, and the only event is `LinkProductSalesChannel.attached`/`detached`.** No `product.updated` fires. The payload carries only the link row id (`prodsc_…`).
- **Latency on Redis is well inside a tick.** In every scenario the last event arrived within 250 ms of the HTTP response.
  - The product, variant and option *update* workflow events arrive before the response: p50 −66 to −7 ms.
  - Other workflow events don't. `inventory-level.updated` arrived after the response in 11 of 14 writes (at most +5 ms). In the fixture's product create, `product.created` came +172 ms after and `product-variant.created` up to +115 ms after.
  - Internal module events at the lowest priority arrive p50 4 to 50 ms and p95 9 to 148 ms after the response.
  - The two 500-row bursts finished draining 191 ms (delete) and 203 ms (create) after the response.
  - On the local bus (which the demo uses), every event arrived before the response.
- **The upsertWithReplace paths emit per row.** Option values replaced through `POST /admin/product-options/:id` fired created, updated and deleted value events. Price-list price batches fired created, updated and deleted price events. The counts matched the rows that actually changed.

## What this means for the plugin surface (the next job)

1. **Subscribe to the module entity events**, not only the workflow events:
   - `pricing.price.*`;
   - `inventory.inventory-level.*`;
   - `product.product.*`, `product.product-variant.*`, `product.product-option.*`, `product.product-option-value.*`.

   The workflow events (`product.updated` and so on) duplicate them for admin writes and add nothing a module event doesn't carry.
2. **Subscribe to `LinkProductSalesChannel.attached`/`detached`.** Resolve the link row id to its product, and make sure that still works after the row is dismissed. This spike didn't check whether a dismissed row is soft-deleted and still resolvable, so the plugin job verifies it.
3. **Resolve other ids to products the same way.**
   - A level event carries only the level id, so resolve level → inventory item → variant link → product.
   - A price event carries only the price id, so resolve price → price set → variant link → product.
   - Option events carry no product id (options are many-to-many in 2.21), so resolve option → products.
4. **Price lists need a scan, not a subscriber.** No event covers a price-list update or status change. `price_list.updated_at` does move, so the price-window job (ADR 0020 §3, deferred) also journals every list whose `updated_at` is newer than its last run. Until that job exists, a price-list edit reaches the till only through the digest audit.
5. **The subscriber has to be registered in every process that writes.** Because the journal row lands in Postgres, the process that handles the event doesn't matter. What this spike shows is narrower than "scripts are covered":
   - A *project* subscriber loads in `medusa exec`. On the local bus the child's own probe recorded all three writes. On Redis the child's subscriber made the child enqueue them.
   - No plugin was installed in this instance, so plugin subscribers in `exec` were not tested.
   - `exec` runs the child in worker mode `server` (`medusa/dist/commands/exec.js:46`), so on Redis the server consumed the jobs.
   - `exec` calls `process.exit()` right after the script (`exec.js:76`). On the local bus, a journal insert slower than the probe's file append (about 70 ms here) could be cut off.

   The plugin job verifies both points: plugin subscribers load in `exec`, and the journal insert completes before exit. Writes from a process that doesn't load the plugin, or raw SQL, are not covered; that's the digest audit's job.

## Setup

- **Instance.** A throwaway Medusa 2.21.0 instance built from this branch's `dev/medusa-store` on the Mac mini: its own database `medusapos_g4`, port 9200, seeded with `seed-e2e.ts`.
  - The shared dev store (`~/Projects/medusa-dev`, database `tallyui_medusa_dev`) wasn't touched, and nothing ran on the VPS.
  - Postgres 17 and Redis 7 run as the local Homebrew services. Redis uses db 5, with the `@medusajs/medusa/event-bus-redis` module selected only by `G4_EVENT_BUS=redis`.
- **Probe.** A `"*"` subscriber (`src/subscribers/g4-event-probe.ts`) appends every event with its arrival time. It's active only when `G4_EVENT_PROBE_FILE` is set, and otherwise subscribes to a name that never fires.
- **Driver.** `scripts/probes/g4-events/driver.mjs` creates its own product (3 variants, a `Size` option, one price each, inventory at the seeded location). It then makes each write through the admin API, strictly one at a time, and collects events from the request start until at least 3 s after the response, plus 1 s of quiet.
- **Coverage** counts the entity ids of the write that appear in some event's payload (any `id`, `*_id` or `*_ids` field).
- **Attribution relies on timing.** The driver assigns an event to a write by arrival time alone. In the committed runs the latest event came 242 ms after its response, and scenarios are at least 3 s apart, so no event was counted against the wrong write. A later harness change bounds each window explicitly.
- **Single client, sequential writes, on an otherwise idle instance.** No concurrent load was measured.
- **Rerun:** `bash dev/medusa-store/scripts/probes/g4-events/run.sh redis|local <out-dir>`. It writes `events.jsonl`, `results.json` and `summary.md`. The raw summaries of this run are in `g4-medusa-events/summary-redis.md` and `summary-local.md`.

## What fires

The event names are identical on both buses; this table uses the Redis run. Latency is from the request start ("fromStart"), which is the admin-edit-to-subscriber time the ruling asked for. The HTTP time is included.

| Write (admin route) | Writes | Events per write | Covered | Redis p50 / p95 ms | Local p50 / p95 ms |
|---|---|---|---|---|---|
| Product update (`POST /admin/products/:id`) | 5 | `product.updated`, `product.product.updated` | 5/5 | 75 / 161 | 64 / 87 |
| Variant title (`POST /admin/products/:id/variants/:vid`) | 5 | `product-variant.updated`, `product.product-variant.updated` | 5/5 | 95 / 252 | 25 / 32 |
| Variant price (the same route, `prices`) | 5 | the above plus `pricing.price.updated` | 10/10 | 118 / 125 | 48 / 113 |
| Stock level (`POST /admin/inventory-items/:id/location-levels/:loc`) | 5 | `inventory-level.updated`, `inventory.inventory-level.updated` | 5/5 levels | 33 / 38 | 24 / 29 |
| Stock batch, 3 levels (`POST /admin/inventory-items/location-levels/batch`) | 3 | the same, once per level | 9/9 levels | 38 / 42 | 39 / 61 |
| Option value added (`POST /admin/product-options/:id`) | 3 | `product-option.updated`, `product.product-option.updated`, `product.product-option-value.created`, 3× `…-value.updated` | option and value, not product | 97 / 109 | 33 / 40 |
| Option value removed (same route) | 3 | the same with `…-value.deleted` | option and value, not product | 96 / 226 | 30 / 30 |
| Product added to a channel (`POST /admin/sales-channels/:id/products`) | 3 | **only** `LinkProductSalesChannel.attached` | link row only | 23 / 24 | 15 / 15 |
| Product removed from a channel (same route) | 3 | **only** `LinkProductSalesChannel.detached` | link row only | 23 / 25 | 18 / 19 |
| Product channels replaced (`POST /admin/products/:id`, `sales_channels`) | 3 | `product.updated`, `LinkProductSalesChannel.attached` and `detached` | 3/3 | 147 / 194 | 66 / 75 |
| Price list created with 9 prices (`POST /admin/price-lists`) | 1 | `pricing.price-list.created`, 9× `pricing.price.created` | 10/10 | 49 / 53 | 31 / 32 |
| Price-list batch: create 2, update 3, delete 1 (`POST /admin/price-lists/:id/prices/batch`) | 3 | 2× created, 1× updated, 1× deleted | every row that changed (below) | 80 / 102 | 66 / 74 |
| **Price list title and dates (`POST /admin/price-lists/:id`)** | 3 | **none** | 0/3 | – | – |
| **Price list status, active ↔ draft (same route)** | 4 | **none** | 0/4 | – | – |
| Direct module writes from `medusa exec`, no subscriber in the child | 3 | **none reached the server** | 0/3 | – | – |
| The same, with a `"*"` subscriber in the child | 3 | Redis: the server got `pricing.price.updated`, `inventory.inventory-level.updated`, `product.product-variant.updated`. Local: the server got none, and the child got all 3. | Redis 3/3, local 0/3 | (process start dominates) | – |

**The batch "update 3" changed one row.** Each batch asked for three amount changes on one variant's tiered prices (`min_quantity` 1, 2, 3). Medusa changed only one of them: a manual `psql` check after the local run showed one row at the new amount and the other two unchanged. An earlier harness version (commit 400029b) sent a 500-price `update` batch across 3 variants. The same check showed it changed 3 of 500 rows (one per variant) and emitted 3 events. That scenario was then replaced by the 500-price delete, which really writes 500 rows. The events match the rows that changed, so this is a Medusa write behaviour, not an event gap. It's recorded here because a tiered bulk edit may not do what the admin asked. It wasn't investigated further.

## Latency by event (Redis, after the HTTP response)

"After response" is the event's arrival time minus the time the response came back. A negative number means the event arrived before the response.

| Event | Count | After response, p50 / p95 ms |
|---|---|---|
| `product.updated` (workflow) | 8 | −66 / −56 |
| `product-variant.updated` (workflow) | 10 | −61 / −46 |
| `product-option.updated` (workflow) | 6 | −7 / −5 |
| `product.product.updated` (module, lowest priority) | 5 | 5 / 9 |
| `product.product-variant.updated` (module) | 10 write-driven | 5 / 19 |
| `pricing.price.updated` (module) | 8 write-driven | 4 / 19 |
| `inventory.inventory-level.updated` (module) | 14 write-driven | 5 / 10 |
| `product.product-option-value.updated` (module) | 18 | 50 / 143 |
| `LinkProductSalesChannel.detached` (link, internal) | 6 | 1 / 21 |
| `pricing.price.created`, burst of 500 | 500 | 95 / 188 |
| `pricing.price.deleted`, burst of 500 | 500 | 112 / 181 |
| `inventory-level.updated` (workflow) | 14 | 11 of 14 after the response, at most +5 |
| `product.created` (workflow, fixture create) | 1 | +172 |

**How to read the Redis numbers.** Workflow events are grouped and released when the workflow finishes.
- For the product, variant and option updates, that happened before the route re-read and responded.
- For the inventory-level writes and the fixture's product create, it didn't.
- Module and link events go out as `internal` jobs at BullMQ priority 2,097,152, the lowest (workflow events use priority 100). They landed tens of milliseconds after the response, with the create burst the latest at 203 ms.
- On the local bus every event, of any kind, arrived before the response.

**Bursts.**
- Creating a price list with 500 prices took 328 ms over HTTP on Redis (1,192 ms on local), and its 500 events drained within 203 ms of the response.
- Deleting those 500 prices in one batch took **9,820 ms** over HTTP on Redis and **25,513 ms** on local. All 500 events arrived within 191 ms of the response on Redis, and before it on local.
- The local figure includes the probe's own file append for each event, in-process. The slow delete itself is a Medusa cost worth knowing about for bulk edits, but it isn't an event-delivery problem.

## Not measured

- **Concurrent load.** Everything here is one client writing one thing at a time. A lowest-priority module event could wait behind a queue of workflow jobs under load; that is the concurrent-till measurement ADR 0020 already plans.
- **Other bulk paths:**
  - price-list rules and customer-group prices (`setPriceListRules_`);
  - the CSV imports (products, price lists);
  - `upsertVariantPricesWorkflow` driven from a bulk product edit;
  - region and currency changes;
  - tax rates.
- **Whether a dismissed `product_sales_channel` link row is soft-deleted** and still resolvable from a `detached` event.
- **Event loss on a crash** between commit and delivery. The source says it's possible (ADR 0020, E2.1). It wasn't provoked here.
- **The shared dev store's own configuration.** This instance ran without the tally plugin.
