# Medusa POS, next release (draft)

**Not releasable yet.** This draft waits for the app's move to TallyUI 3.0.0, and nothing is tagged or published before TallyUI/tallyui#242 is proven and Paul gives the go-ahead (see the [release checklist](../release-checklist.md)). At release time, rename it to `v<version>.md` and fill in the version and date.

## Before you update your tills

This update changes how each till stores its sales, and there is no going back.
- **Before you update,** make sure every till has sent all its sales: nothing waiting to sync.
- **After you update,** don't install an older version again. An older version can't read the new storage. It shows none of the till's sales and doesn't send the ones still waiting.
- **If a till ever shows no sales after going back to an older version, don't ring those sales again.** Update the till and they come back. Ringing them again would count them twice.

## What's new for your store

- **Registers are recorded by the server.** When a till opens, counts and closes a register, your Medusa store records it and works out what the drawer should hold from the sales it received. The till's own figures (expected, counted and variance per payment method) are on its "Last closure" screen, under Register. The app doesn't show the store's figure yet; it's available from the plugin's register endpoint, `GET /tally/v1/registers/{id}`.
- **Sales that need an admin are held, not lost.** If a sale can't be finished automatically (for example, its order was changed by hand in Medusa), it waits for an admin. The admin then completes it or rejects it with one command.
- **Rejected sales don't count in the day's figures.** A sale an admin rejects no longer counts in the register's expected cash. A one-off step fixes sales rejected before this update. It first shows you exactly which closed days would change, and it can be undone.
- **Stock stays right when a sale fails.** If a sale fails partway, the stock it took is put back exactly once.
- **The till's stock location must belong to your sales channel.** A sale can no longer take stock from a location that isn't linked to your sales channel. The sale stays on the till's Orders screen as needing attention, with the store's message saying it's a store setup problem. Link the location to the channel in Medusa, then tap Retry on that sale and it goes through.
- **Resent sales answer the same way.** A sale the store already recorded always answers its recorded result when a till sends it again. That includes after a server update, and when a till resends a sale.
- **Oversized batches get a clear answer.** A batch of more than 50 sales, or one over the size limit, is refused whole, with the limit in the answer. Splitting it and resending in smaller pieces comes in a later version of the till.
- **Experimental catalogue sync is included but off.** It's the server side of a faster catalogue sync. It stays off unless you turn it on.

## For developers

Plugin changes since 0.1.0 (merged):
- **Registers:** the register commands, server-derived `expected`/`salesCount`, and `GET /tally/v1/registers/{id}` (#98, #99, #100). A stored register rejection replays unchanged (#108).
- **`needs_admin` and the `tally-ledger-resolve` apply/reject script** (#115).
- **Stock safety:** the take-back and fulfilment compensation are failure-safe (#116, #117).
- **A new command id for a `clientOrderId` that already has an order** follows the original command's ledger state (#118).
- **Replay first,** then length bounds and NUL (#120); a docs follow-up (#122).
- **Rejected orders:** marked `tally_rejected` and excluded from register figures (#121). A one-off backfill with a dry run, a per-session report and undo (#127).
- **Stock location:** it must exist and belong to the sale's sales channel (#130).
- **413 answers:** `batch_too_large` / `body_too_large` (#134).
- **Experimental sync:** the `tally_sync` change journal, `/changes` routes and the rescan script, behind `experimentalSync`, off by default (#110, #112, #114).
- **Security:** the `majorToMinor` ReDoS fix (#111).
- **More than one Medusa instance needs a shared locking provider (Redis or Postgres):** the plugin warns once at startup while Medusa's in-memory locking provider is active (#154).
