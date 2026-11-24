# Till refunds are Medusa returns plus one payment refund, priced and split by the store

Status: Accepted (front desk rulings A–F, 2026-11-22; approved by the front desk 2026-11-22 at 0204c3d7)
Date: 2026-11-22
Supersedes: none. It implements TallyUI ADR-080 (order.refund v1) for Medusa.

## Context

v2 parity row 10.3 / 13.1 is the refund a cashier starts from the Orders sheet. TallyUI 4.1.0 (pinned in #517) ships every client piece:
- `OrderDetail.onRefund`, `RefundModal` and `RefundForm`;
- pos `submitOrderRefund`, `posRefundCollection` and `priceRefund`;
- `ServerCapabilities.orderRefund`.

ADR-080 (TallyUI `docs/DECISIONS.md`) fixes the `order.refund` v1 command:
- its payload (`clientRefundId`, `orderId`, `lines: [{ orderLineId, quantity, restock }]`, `shippingMinor`, `adjustmentMinor`, `totalMinor`, `destination`, `reason`, `registerId`, `sessionId`);
- the shared shape check `refundPayloadErrors`;
- the applied result `refund: { totalMinor, byMethod, refunds: [{ id, paymentId, totalMinor, state }] }`;
- the refusal codes: `nothing_to_refund`, `quantity_exceeds`, `amount_mismatch`, `order_state`, `not_till_order`, `forbidden` and `no_open_session`;
- decision 6, the register figures;
- Amendment 3: a new command id carrying an already-applied `clientRefundId` is answered `invalid_payload` with "clientRefundId: <id> is already refund <refundId>".

The Medusa side has nothing yet:
- `commands/process.ts` accepts only `order.create` and `register.*`, and refuses the batch on any other type.
- `tally-ledger/command-result.ts` refuses an applied result that carries neither server refs nor register figures.

Medusa 2.21 facts this design rests on:
- **One payment per till order.** A till order has one Medusa payment (`pp_system_default`). The till's tenders exist only in `order.metadata.tally_payments`. A sale discounted to 0 has no payment collection (ADR-062).
- **Money moves alone.** `refundPaymentWorkflow({ payment_id, amount, note })` refunds money and restocks nothing.
- **Stock comes back only through a return.** Medusa restocks only through the return order-change chain: begin return, request items, confirm request, begin receive, receive items, confirm receive. Each is its own workflow and transaction. `createAndCompleteReturnOrderWorkflow` does not restock. A damaged receive records the item without restocking it.
- **Where the sale happened.** The till's stock location is the `locationId` the sale was created with (`tally-order-create`).
- **The connector's line split.** connector-medusa splits a line as `net = round(gross − tax)`. The plugin's own `orders/list.ts` uses `round(gross) − round(tax)`, and the two differ by one minor unit on some lines.

## Decisions

### 1. v1 is a full-order refund in the app; the plugin takes the general payload (ruling A)
The app offers only "Refund all": every line, every unit, the shipping, and no adjustment.

The plugin still accepts and prices ADR-080's general payload: any line quantities, shipping and an adjustment. It answers `quantity_exceeds` against what earlier refunds already took back. So partial refunds need only app work and the per-line read (decision 3). They are the next queue item.

### 2. One plugin workflow runs Medusa's own return chain, then one payment refund (ruling B)
`order.refund` runs one plugin workflow, serialised per order:

1. **Return.** Begin a return on the order, request the refunded lines and quantities, and confirm the request.
2. **Receive.** Receive at the till's stock location, the sale's `locationId`, and confirm the receive.
   - A line with `restock: true` is received normally, so its items go back into stock.
   - A line with `restock: false` is received as damaged: recorded on the return, not restocked.
   - A refund with no lines (shipping or adjustment only) skips steps 1 and 2.
3. **Money.** One `refundPaymentWorkflow` on the order's payment, for the refund's total, with `note` set to the reason.
   - A sale with no payment collection (discounted to 0) has no money to refund, so its refund is refused `nothing_to_refund` before step 1.
4. **Record.** Mark the `tally_refund` row applied (decision 3), and the ledger command applied, with the result.

**A failure before step 1 confirms** rolls back with the step's own compensation. Nothing has changed in Medusa, and the command is refused with the error's code.

**A failure after the return request confirms goes to `needs_admin`.** A retry with the same `clientRefundId` resumes from the recorded step, or answers the same result. It never refunds twice:
- **How it resumes.** Each step writes its outcome to the `tally_refund` row before the next step starts: `return_id`, then `received_at`, then `medusa_refund_id`. A retry reads the row and runs only the steps that are missing.
- **A crash or timeout.** The ledger claim stays `in_progress`. After the stale-claim window, the till's retry takes the claim over, as order.create's does, and resumes.
- **A failure that will not clear on retry.** The workflow parks the command as `needs_admin`, with the failing step in `needs_admin_reason`. Until an admin resolves it, the till's retry is answered `in_progress`, as for order.create. The admin uses `tally-ledger-resolve` with one of two actions:
  - `resume` runs the missing steps;
  - `apply` records a refund the admin made by hand, with its Medusa refund id;
  - `move [<sessionId>]` (#542, desk ruling 2026-11-24) changes a parked refund whose session no longer takes money to an open session, then resumes it.
    - By default the target is the sale register's own open session. Another register's session must be named, because the cash then leaves a different drawer, and the log line says so.
    - It refuses while the old session still takes money (use `resume`), once the row records its Medusa refund, and for a target that is not open.
    - Each move appends `{ refundId, commandId, fromSessionId, toSessionId, at }` to the order's metadata `tally_refund_moves`, in the same transaction, merged into the metadata. No migration.

  There is no `reject` once stock has moved.

  Two more admin actions live in `tally-refunds` (#542):
  - `baseline <orderId> <medusaRefundId> [--hand-made] <reason>` records a Medusa refund made outside the plugin, so the never-twice check stops counting it as unrecorded.
    - The entry is `{ refundId, amountMinor, at, reason }` in the order's metadata `tally_refund_baselines`, merged into the metadata. A reason is required.
    - The check reads each baselined refund's amount live from Medusa. A lost or cleared key fails closed: the refund counts as unrecorded again and the check refuses.
    - A refund whose amount equals a pending till refund's needs `--hand-made`, because it may be that refund's own money, which `apply` records instead.
  - `list` prints the parked refunds, then the moved ones with their current status. It is a script only, with no Admin route.
- **Never refund twice.** The workflow compares the payment's refunded amount in Medusa with the sum of the `medusa_refund_id` amounts that `tally_refund` already records for it. If Medusa shows more, a refund happened without being recorded, and the command goes to `needs_admin` with the reason `refund_unrecorded`.
  - The check runs before step 2, so stock never moves when the money won't (amended 2026-11-23, desk ruling).
  - It runs again before step 3, for a resume whose receive is already recorded.
  - A refund with no lines runs it once, before step 3.

**Required tests.** The plugin PR tests these rows explicitly:
- Fail after the receive confirms and before the money moves, then retry with the same command and `clientRefundId`: exactly one Medusa refund, and stock received once.
- Fail after `refundPaymentWorkflow` returns and before the row records it, then retry: no second Medusa refund, and the command is in `needs_admin` with `refund_unrecorded`.
- A new command id with the `clientRefundId` of an applied refund: `invalid_payload` per Amendment 3.
- A new command id with the `clientRefundId` of a refund still in progress or in `needs_admin`: answered `in_progress`, with no second workflow.

**Why the return chain.** The alternative was money only, with stock fixed through inventory levels. It would skip Medusa's returns, and Admin would show no return on the order.

### 3. A `tally_refund` table keyed by `clientRefundId` (ruling C)
A new model in the plugin's ledger module.

**Columns:**
- `id`, the refund id returned to the till;
- `client_refund_id`, with a unique index;
- `command_id`, `order_id` and `session_id`;
- `status` (`in_progress`, `applied`, `needs_admin`);
- `lines` as `[{ orderLineId, quantity, restock, netMinor, taxMinor }]`;
- `shipping_minor`, `adjustment_minor`, `total_minor` and `reason`;
- `by_method` and `refunds`, the result's split (decision 4);
- `return_id`, `received_at` and `medusa_refund_id`, the resume points (decision 2);
- `created_at` and `updated_at`.

**Readers:**
- `GET /tally/v1/orders` fills each order's `refunds` from the applied rows. Their per-line quantities are what partial refunds will need for `RefundForm`'s earlier refunds.
- The register figures read it too (decision 6).

This is a migration: one-way storage. The desk accepted it (ruling C).

### 4. With `original_method`, non-cash tenders are refunded first, the rest goes on cash (ruling D)
**`destination: cash`** puts the whole refund on cash.

**`destination: original_method`** splits the refund over the sale's tenders in `tally_payments`, in the order they were taken:
1. Each non-cash tender is refunded first, up to the amount it took less what earlier refunds already gave back to it. The amount a tender took is its `amountMinor`, never `tenderedMinor`, so change given on a cash tender is never refundable.
2. Whatever is left goes on cash.

Each `refunds[]` entry names the till's own payment id (`paymentId`) and its amount. `byMethod` sums them by method.

Medusa sees one `refundPaymentWorkflow` for the total, on the order's single payment. The split is the till's view, and `tally_refund` keeps it.

**Where the order comes from.** Neither ADR-080 nor pos `priceRefund` states an order across tenders:
- ADR-080 decision 4 says only that `byMethod` is "cash for a cash destination, else the original payment's method".
- `priceRefund` prices lines and has no tender logic.

So this order is ours (ruling D). If a later TallyUI ADR states one, it wins, and this decision follows it.

**Required tests:**
- A card + cash sale, refunded in full: the card gets back what it took, and cash takes the rest.
- A cash tender that gave change: the refund on cash is at most its `amountMinor`, never its `tenderedMinor`.
- A second refund attempt after a full one: `quantity_exceeds`, and no Medusa write.

### 5. The store re-prices with the connector's split (must be right: money)
The plugin prices the refund with ADR-080's cumulative-share rule, net and tax separately, the way pos `priceRefund` does. It compares the result with the till's `totalMinor` and answers `amount_mismatch` on any difference, or when it exceeds the order's refundable money. An order without `tally_client_id` metadata is refused `not_till_order`, and one that is a draft or canceled is refused `order_state`.

Each line's net is `round(gross − tax)`, the connector's split, never `round(gross) − round(tax)`. The till prices from the connector's figures, so any other split would refuse a correct refund by one minor unit.

Shipping methods and fee items are rounded per item for the same reason (amended 2026-11-24): the order's shipping is the sum of each method's rounded gross, and ruling A's lines' money is the rounded payment less each shipping method's and each fee's rounded gross, not one rounding over their raw sum.

**The last units take the remainder** (amended 2026-11-23, desk ruling). Per-line rounding can ask for more than the till took. Take three one-unit lines at 0.99 ex 19%: each line is 1.18, which sums to 3.54, but the sale was paid 3.53.

So a refund that leaves every product line fully refunded prices its lines at the money left for the lines. The difference from the per-line sum goes on one of the request's lines. The till prices the same way. TallyUI 4.1.0's `priceRefund` does not, so the app sends the remainder for its full-order refund.

**Desk rulings of 2026-11-23 on the money review of #540 (A to E).**
- **A. The lines' money.** For the last units, the lines' money is: payment amount − the order's shipping (gross) − the order's till fees (gross) − Σ the line money (net + tax) of every earlier `tally_refund` row of the order. The payment and each shipping method and fee are rounded on their own (decision 5, amended 2026-11-24).
  - **Earlier rows.** Rows count when they have moved money or still can: `in_progress`, `applied` and `needs_admin`. A refund that fails before its money moves deletes its row, so it never counts.
  - **Fees.** Fee items (`metadata.tally_fee_uuid`) are not lines here. They are not in the "every line refunded" set, and they are not in the bound's line count. A fee goes back only as `adjustmentMinor`, under the overall cap.
  - **Never in the remainder.** Adjustments and shipping refunds.
- **B. Which line takes the difference.** The request's last line whose net covers the difference (net ≥ |difference|). If no line does, the line with the largest net, with ties going to the later line. A net is never negative. The till applies the same rule.
  - **Ruling N1** (desk, 2026-11-23, review 2). A negative difference that no net in the request covers goes on the tax of the request's line with the largest gross (net + tax); ties go to the later line. The tax takes it only if it covers it.
  - Otherwise, within D's bound, the difference is dropped and the lines price at their own figures; no net or tax is ever negative. Beyond the bound it is money drift. The till applies the same rule.
  - **Accepted limit:** a dropped difference over-refunds the lines by at most one minor unit per line; the payment cap still bounds the order's refunds.
    - Example: 3 × 0.99 ex 19% plus a free line z, with 5.95 of shipping (paid 9.48). Refunding a, b and c singly takes 1.18 each, 3.54 against 3.53 of line money.
    - z alone then prices at 0 and is refused `nothing_to_refund`.
    - A stock-only return of a free line is not in v1.
- **C. A resume or takeover after the session has closed.** The refund parks again as `needs_admin`, reason `session_closed`, with no money and no stock moved. The closed session's figures never move.
  - On the till, the refund reads as in progress, never as paid. TallyUI's wire has no message for a parked command; the plain "not paid" wording on the till is a TallyUI contract change: TallyUI/tallyui#1280.
  - The admin finishes such a refund with `move` (decision 2, #542).
- **D. Money drift.** A difference of more than one minor unit per product line means the payment and the order disagree by more than rounding. It is refused `order_state` with `{ state: 'money_drift' }`, for an admin. `amount_mismatch`, which carries `serverMinor`, is only for a till total that differs from the server's price.
- **E. Shipping basis.** `shippingMinor` is gross: net + tax, the orders list's two shipping figures added.

**The overall cap.** A refund's total may not exceed the payment's amount less Medusa's refunds, less the totals of earlier rows that have not yet reached Medusa.

**Medusa credit lines.** Medusa 2.21's `refundPaymentWorkflow` records any refund above the order's pending difference as an order credit line. So a shipping-only refund, an adjustment, or a line priced up by rounding shows in Admin as a credit line on the order.

**Required tests.**
- **Per-line rounding.** A line where `round(gross) − round(tax)` and `round(gross − tax)` differ by one minor unit: the refund is accepted, and its amounts are the connector's.
- **Per-order rounding.** Refunding all three lines of the 3.53 sale above gives 3.53. Refunding two of them gives 2.36, and the last line then gets 1.17.
- **The rulings' cases** (2026-11-23):
  - The 3.53 sale with a 1.19 fee, paid 4.72: refunding all three lines gives 3.53.
  - +1 goodwill first: the last units still get 3.53. −3 withheld on the first line: the last two get 2.35.
  - A parked earlier refund does not block the last units.
  - A free last line keeps a net ≥ 0.
  - Money drift answers `order_state` `money_drift`, with no `serverMinor`.
  - A resume after the session closed parks `session_closed` with nothing moved.

### 6. Register figures follow ADR-080 decision 6
- **The session.** A refund counts in its own `sessionId`, which must be open, not counting, and have no filed closure. Anything else is refused `no_open_session`.
  - A refund already started may finish (resume or `apply`) while its session is counting, as cash movements may, until a closure is filed (ruling F3, 2026-11-23).
  - A till that counted before it finished shows the difference as a variance at the gate. The check holds the session row lock, as the register commands do (`lockSession`), so a close cannot interleave with a refund.
- **Expected per tender.** `deriveSessionFigures` takes the session's applied refunds, `[{ byMethod }]`, and each tender's expected figure falls by that refund's `byMethod`.
- **Closure totals.**
  - `periodRefundsTotalMinor` is the sum of the session's applied refunds.
  - `perpetualRefundsTotalMinor` accumulates across sessions.
  - **2026-11-24 (#544):** when the server holds every sale (the ADR 0023 condition of 2026-11-22/23), the session's applied refunds are stored as the period, and a differing till figure is kept in `till_period_refunds_total_minor`. The stored perpetual is the register counter plus the stored period, read and written under the register lock. The result carries `closure.refunds = { tillMinor, serverMinor }`, the difference is logged as a warning, and there is no gate. The till adopts the counters raise-only, so its own counter can stay high on its screen until TallyUI adopts a lowered counter.
- **Contract.** The register contract version does not change.

### 7. Who may refund: the closure-approval manager check (ruling E)
Under ADR 0023, a refund needs a user whose roles grant `tally_pos:approve_variance`, read live with `hasPermission`, as for closure approval. With RBAC off, every admin counts.

Anyone else is refused `forbidden`, and the app shows TallyUI's own text for that refusal.

### 8. Contract and capability
- `/info` advertises `contracts['order.refund'] = [1]`, and `PLUGIN_CONTRACT` goes from 4 to 5.
- The app sets `REFUND_PLUGIN_CONTRACT = 5` and turns on `ServerCapabilities.orderRefund` only against a plugin at 5 or above.
- Against an older plugin, Refund stays hidden.

## Consequences
- **Three PRs** (ruling F), none of them needs-paul:
  1. this ADR, which the desk approves;
  2. the plugin: intake, `tally_refund`, the workflow, figures and contract 5. It is must-be-right money: an independent Opus reviewer re-derives the refund amounts and reruns the tests, then the desk reads it;
  3. the app, last.
- **One-way storage.** The `tally_refund` migration cannot be undone without losing refund records.
- **Admin sees the real thing.** Each till refund appears in Admin as a Medusa return plus a refund on the order's payment. The till's per-tender split is visible only through the plugin.
- **Repair is by hand.** A `needs_admin` refund waits for an admin with `tally-ledger-resolve`, and the till shows it as in progress meanwhile.
- **Partial refunds** are app work plus the per-line read, on this plugin. They are the next queue item.
