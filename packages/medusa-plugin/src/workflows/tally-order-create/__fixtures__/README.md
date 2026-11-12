# Fixtures

- `order-create-v3.json`: the golden v3 envelope (ADR 0012).
- `order-create-envelopes-2026-09-30/`: order.create envelopes recorded on 2026-09-30 from TallyUI's own
  `toOrderCreateEnvelope`, for `@tallyui/pos` 2.0.0 (v1, v2) and TallyUI main at `01c45da` (v1, v2, v3).
- `register-envelopes-2026-09-30/`: register envelopes recorded on 2026-09-30 from TallyUI main at `af4672f`
  (`main-batch.json` is the whole captured POST /tally/v1/commands request).
- `order-create-coupon-envelopes-2026-11-12/`: two v6 envelopes recorded on 2026-11-12 from `@tallyui/pos` 3.19.0 by
  `record.mjs` in that folder. Each is a 1190 tax-inclusive line at 19% with a 100 store-priced coupon, with
  (`inclusive-line-discount-coupon.json`) and without (`inclusive-coupon.json`) a 10% line discount.
  - The first is the 990 vs 971 repro of TallyUI #787: 3.19.0 sends the line's `discountMinor` as 84 instead of 100.
  - So the plugin refuses a coupon beside a tax-inclusive till discount until a payload carries per-line coupon amounts
    (front desk ruling, 2026-11-12).

The two 2026-09-30 sets are copied unchanged from the recording handoffs (`~/agent/handoff/order-create-envelopes-2026-09-30/`
and `~/agent/handoff/register-envelopes-2026-09-30/`), whose READMEs describe how they were made. They are the
regression proof for ruling 17 (strict fields): every one must pass the plugin's checks unchanged.
