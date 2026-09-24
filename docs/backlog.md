# App backlog

## Single-variant products show stock nowhere in the app

The app's only stock display is the variant chooser (`In Stock · as of …`),
and the chooser only opens for a product with more than one variant — a
single-variant product (most of the catalogue) shows no stock anywhere.
TallyUI's `ProductStockBadge` is overlay-aware (ADR-060) as of TallyUI #55,
so it can be placed on the product tiles in `apps/expo/components/catalogue.tsx`
to close this gap. Small follow-up, after the TallyUI sign-in bump.

## The open variant chooser doesn't refresh live

`Catalogue` (`apps/expo/components/catalogue.tsx`) stores the chooser's
entries in `choices`, a snapshot taken when it was opened. A stock reconcile
that lands while the chooser is already open doesn't update it — the cashier
has to close and reopen it to see the new status. The chooser should read
live entries (e.g. re-derive `choices` from `entries` instead of snapshotting
them) so it reflects reconciled stock while it's open.
