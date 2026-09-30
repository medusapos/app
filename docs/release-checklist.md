# Release checklist

Work through this before tagging a release of the app or the plugin. An item that doesn't apply to the release is marked "n/a" with a reason in the release PR, never skipped silently.

## Gates

- [ ] **RxDB 17.5 storage (TallyUI 17.5 packages):** no app release on `@tallyui/*` packages built on RxDB 17.5 until TallyUI/tallyui#242 has proven the upgrade on browser OPFS, iOS and Android (issue #128).
  - **Never roll a release back across this version.** The upgrade changes local storage one way. A till that ran the new version and is rolled back to an older build shows no orders until it's upgraded again. A fix after release goes forward, never back.
  - The bump PR carries a carry-over test for every collection the app owns (`pos_orders`, `register_sessions`, `cash_movements`, `closures`, and the parked-sale drafts). The released build writes the documents, the new build opens the store, and whole documents are compared (issue #128).

## Every release

- [ ] CI is green on the release commit: plugin suites, the seeded backfill run, end-to-end (web), and the demo backend image.
- [ ] The release notes draft (`docs/release-notes/v<version>.md`) lists what changed for tills, stores and operators, and every gate above that applies.
- [ ] Plugin: `npm run build` from `packages/medusa-plugin`, and the package contents are checked (`.medusa/server` only).
- [ ] Any change to the command contract (codes, limits, fields) matches the TallyUI core version the app pins, and says which `@tallyui/*` version the app needs.
