# App backlog

## The open variant chooser doesn't refresh live

`Catalogue` (`apps/expo/components/catalogue.tsx`) stores the chooser's
entries in `choices`, a snapshot taken when it was opened. A stock reconcile
that lands while the chooser is already open doesn't update it — the cashier
has to close and reopen it to see the new status. The chooser should read
live entries (e.g. re-derive `choices` from `entries` instead of snapshotting
them) so it reflects reconciled stock while it's open.
