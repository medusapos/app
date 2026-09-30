# Fixtures

- `order-create-v3.json`: the golden v3 envelope (ADR 0012).
- `order-create-envelopes-2026-09-30/`: order.create envelopes recorded on 2026-09-30 from TallyUI's own
  `toOrderCreateEnvelope`, for `@tallyui/pos` 2.0.0 (v1, v2) and TallyUI main at `01c45da` (v1, v2, v3).
- `register-envelopes-2026-09-30/`: register envelopes recorded on 2026-09-30 from TallyUI main at `af4672f`
  (`main-batch.json` is the whole captured POST /tally/v1/commands request).

Both sets are copied unchanged from the recording handoffs (`~/agent/handoff/order-create-envelopes-2026-09-30/`
and `~/agent/handoff/register-envelopes-2026-09-30/`), whose READMEs describe how they were made. They are the
regression proof for ruling 17 (strict fields): every one must pass the plugin's checks unchanged.
