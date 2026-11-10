# MedusaPOS against demo.wcpos.com/pos, screen by screen

- **Date:** 2026-11-10
- **Demo:** https://demo.wcpos.com/pos (WCPOS 2.0.0, signed in with the published demo / demo)
- **MedusaPOS:** `2ebcb77` (`apps/expo` web export, e2e store: 5 E2E products, EUR, Europe region with 25% VAT)
- **Viewports:** desktop 1280×800. Phone 390×844 was planned but not captured on either side (see "Not captured").
- **Rubric:**
  - `match`: a cashier would not notice a difference.
  - `close`: same job and same place, with visibly different controls or density.
  - `gap`: missing, or done in a way a cashier trained on WCPOS would stumble over.
  - `N/A`: WooCommerce or WordPress only; the row names Medusa's own way.
  - `not rated`: the MedusaPOS shot was not captured before the time limit.
- **Score: 0 / 27 match** (14 close, 13 gap; 5 N/A and 17 not-rated rows are excluded).

## How the shots were taken

The demo was used read-only.

- A Playwright route guard aborted:
  - every non-GET request except the WordPress sign-in form post;
  - every host outside demo/docs.wcpos.com.
- The guard did allow GETs of the app bundle from `cdn.wcpos.com` and `cdn.jsdelivr.net/gh/wcpos/`, because without them the app stays on its splash screen.
- The demo app's own background POSTs were all aborted. These were `wp-json/wcpos/v2/push/orders`, updates.wcpos.com, api.notifications.wcpos.com and the beacon.
- Choosing an already-open register only binds the browser locally.
- States that need a write were not taken from the demo. Instead:
  - they use the docs.wcpos.com screenshot, marked "demo: docs <url>";
  - or, where an open cart already existed on the demo, it was viewed but not changed.

Catalogue size is ignored throughout.

Owners:
- `app`: `apps/expo`
- `TU <package> <component>`: TallyUI
- `plugin`: `packages/medusa-plugin`

D = `https://docs.wcpos.com/img/2.x`

## Checklist

| id | screen / state | demo shot | MedusaPOS shot | rating | differences (most visible first) |
|---|---|---|---|---|---|
| 01 | POS main, empty cart | [demo](demo-shots/01-pos-empty-cart-demo-desktop.jpg) | [medusapos](demo-shots/01-pos-empty-cart-medusapos-desktop.jpg) | gap | 1. No left icon rail; navigation is text links in a "Products" title bar (`app`). 2. Browse starts on product tiles with small category chips; the demo starts on large coloured category tiles (`TU components CategoryNav`). 3. No filter pills (In Stock, Featured, On Sale, Tag, Brand) and no scan or settings icons next to search (`TU components FilterChipGroup`, `app`). 4. No open-orders tab strip under the cart; "Parked sales" is a text link (`TU components Cart`). |
| 02a | Product tiles, search | [demo](demo-shots/02-product-search-demo-desktop.jpg) | [medusapos](demo-shots/02-product-search-medusapos-desktop.jpg) | close | 1. No product image; tiles are text cards (`TU components ProductCard`, `app` image wiring). 2. A stock badge on every tile; the demo shows none on tiles (`TU components ProductCard`). 3. Name centred above price; the demo puts name and price bottom-left over the image. |
| 02b | Product table | [demo](demo-shots/02-product-table-demo-desktop.jpg) | [medusapos](demo-shots/02-product-table-medusapos-desktop.jpg) | close | 1. No thumbnail, stock count or category line per row (`TU components ProductTable`). 2. No per-row "+" add button (`TU components ProductTable`). 3. Grid/Table is a segmented control beside the search box; the demo uses an icon toggle in the search row. |
| 02c | Variable product | [demo tiles](demo-shots/02-variable-tiles-demo-desktop.jpg) | [medusapos](demo-shots/02-variant-chooser-medusapos-desktop.jpg) | close | 1. The tile says "from €10.00" with no "n options" count (`TU components ProductCard`). 2. The demo chooser could not be opened in price-check mode, so only the tiles are compared; the chooser itself is unverified (`TU components ProductVariantPicker`). |
| 02d | Product display settings | [demo](demo-shots/02-display-settings-demo-desktop.jpg) | none | gap | 1. No product settings sheet: tile size, browse by, sort, out-of-stock toggle, variations in place or popover, tile fields (`app`, `TU components ProductGrid`). |
| 02e | Category filter | [demo](demo-shots/02-filter-category-demo-desktop.jpg) | [medusapos](demo-shots/01-pos-empty-cart-medusapos-desktop.jpg) | close | 1. Categories are always-visible chips (All products / Drinks / Food); the demo uses a Category pill menu or category tiles (`TU components CategoryNav`). |
| 03a | Cart with items | [demo](demo-shots/03-cart-items-demo-desktop.jpg) | [medusapos](demo-shots/03-cart-items-medusapos-desktop.jpg) | gap | 1. Each line is a stacked block with −, + and Remove buttons; the demo uses a compact QTY / ITEM / PRICE / TOTAL table with a tappable qty box (`TU components Cart`). 2. No single "Checkout €x" button; two Cash / Card terminal buttons take its place (`TU components Cart`, `app`). 3. No struck-through regular price on sale items (`TU components Cart`). 4. "Order discount" and "Add charge" buttons sit among the lines and push them down (`TU components Cart`). |
| 03b | Line qty / price edit | demo: docs D/pos/cart/line-items/en/tablet-light-regular--l1-2-quantity-keypad.png | [medusapos](demo-shots/03-cart-line-price-medusapos-desktop.jpg) | gap | 1. Price edit opens an inline form (EUR field, Reason, Apply / Cancel) that pushes the cart down; the demo opens a numeric keypad popover on the line (`TU components Cart`). 2. No keypad for qty; only the −/+ buttons (`TU components QuantityStepper`). |
| 03c | Line discount | demo: docs D/pos/cart/discounts/en/tablet-light-regular--discounts-1-price-keypad.png | [medusapos](demo-shots/03-cart-line-discount-medusapos-desktop.jpg) | close | 1. The discount shows as a red "10% −€0.40" chip under the line; the demo shows a struck-through price in the PRICE column (`TU components DiscountChips`). 2. No quick-discount keys (−5/−10/−15%) on a keypad (`TU components DiscountForm`). |
| 04a | Customer picker | [demo](demo-shots/04-customer-picker-demo-desktop.jpg) | [medusapos](demo-shots/04-customer-picker-medusapos-desktop.jpg) | close | 1. A centred modal; the demo drops a search list from the customer chip (`TU components CustomerPicker`). 2. "Customer: Guest" is plain text; the demo shows an avatar chip plus an address button (`TU components Cart`). 3. No Guest row at the top of results. |
| 04b | New customer | demo: docs D/customers/index/en/tablet-light-regular--cust-5-free-preview.png (greyed without Pro) | [medusapos](demo-shots/04-customer-new-medusapos-desktop.jpg) | close | 1. Reached from "New customer" in the picker; the demo reaches it from the cart "+" menu or the Customers screen (`TU components CustomerForm`). |
| 05a | Cart add menu | [demo](demo-shots/05-cart-add-menu-demo-desktop.jpg) | [medusapos](demo-shots/05-cart-add-charge-medusapos-desktop.jpg) | gap | 1. No "+" menu in the cart header; "Add charge" and "Order discount" are separate inline buttons (`TU components Cart`). 2. No "Add Miscellaneous Product" (custom line) (`TU components Cart`, `plugin`). 3. Shipping and fee are one "charge" form, not two entries (`TU components Cart`). |
| 05b | Fee / shipping line | demo: docs D/pos/cart/index/en/tablet-light-regular--cart-5-add-fee.png, D/pos/cart/index/en/tablet-light-regular--cart-6-add-shipping.png | [medusapos](demo-shots/05-cart-with-charges-medusapos-desktop.jpg) | close | 1. Charges sit as lines with Remove; the demo keeps fees and shipping last in the table, with the same columns (`TU components Cart`). |
| 05c | Order discount | demo: docs D/pos/cart/discounts/en/tablet-light-regular--discounts-4-add-discount.png | [medusapos](demo-shots/05-cart-order-discount-medusapos-desktop.jpg) | close | 1. Inline form under the lines; the demo opens it from the "+" menu (`TU components DiscountForm`). 2. Totals show "Discount −€x" as the demo does. |
| 05d | Cart settings | [demo](demo-shots/05-cart-settings-demo-desktop.jpg) | none | gap | 1. No cart settings: cart left or right, open orders top or bottom, sort, quick discount values, auto show/print receipt, columns (`app`). |
| 06a | Tender, cash | demo: docs D/pos/checkout/tender-pane/en/tablet-light-regular--tp-1-cash-change.png | [medusapos](demo-shots/06-tender-medusapos-desktop.jpg) | gap | 1. The tender is a small form in the cart column; the demo swaps the product side for a full tender pane with the order summary kept beside it (`TU components Tender`, `app`). 2. No on-screen numeric keypad (`TU components CashTendered`). 3. No Cash / Card method tiles on the tender screen; the method is chosen before it, from the cart buttons (`TU components Tender`). 4. The primary button reads "Complete sale"; the demo says "Take $45.00 in Cash" (`TU components Tender`). |
| 06b | Change due | demo: docs D/pos/checkout/en/tablet-light-regular--j2-8-change-due.png | [medusapos](demo-shots/06-tender-change-due-medusapos-desktop.jpg) | close | 1. Change is shown in a grey box under the input; the demo shows it as the large green headline (`TU components ChangeDisplay`). 2. Quick amounts are the total and the next note, as in the demo, but there is no "Exact" button. |
| 06c | Split payment | demo: docs D/pos/checkout/en/tablet-light-regular--j2-9-split.png | [medusapos](demo-shots/06-tender-split-medusapos-desktop.jpg) | close | 1. "Split payment" is a text toggle; the demo uses a Split pill beside "To pay" with 2–5 ways and percent (`TU components SplitTender`). |
| 07 | Paid / receipt | demo: docs D/pos/checkout/en/tablet-light-regular--j2-6-see-paid.png | not captured | not rated | The demo paid screen has: big change; template and printer pickers; a receipt preview; Email Receipt / Download PDF / Print Receipt / New sale. |
| 08 | Open orders / parked | demo: docs D/pos/cart/open-orders/en/tablet-light-regular--oo-1-strip.png, plus the strip in [demo 01](demo-shots/01-pos-empty-cart-demo-desktop.jpg) | [medusapos](demo-shots/08-parked-sales-medusapos-desktop.jpg) | gap | 1. Parked sales live in a modal behind a text link; the demo keeps every open cart as a tab (customer, total, age) under the cart (`TU components Cart`, `app`). 2. A sale must be parked explicitly ("Park this sale"); in the demo a new tab ("+ New") parks it implicitly (`TU components Cart`). |
| 09a | Choose register | [demo](demo-shots/09-register-choose-demo-desktop.jpg) | [medusapos](demo-shots/09-register-picker-medusapos-desktop.jpg) | close | 1. Card above the cart with "Not opened"; the demo replaces the cart with the register list and shows who opened each and since when (`TU components RegisterPicker`). 2. No "price check only until the register is open" banner on the products side (`app`). 3. An orange "Choose a register" badge sits in the register bar; the demo puts the state next to the store name. |
| 09b | Open register / float | demo: docs https://docs.wcpos.com/sell/open-register (no screenshot published) | [medusapos](demo-shots/09-register-open-float-medusapos-desktop.jpg) | close | 1. Float entry card (`TU components OpenRegisterCard`); not compared beyond layout because the demo cannot be opened read-only. |
| 09c | Register panel / cashier sheet | [demo](demo-shots/09-register-panel-demo-desktop.jpg), demo: docs D/pos/register/en/tablet-light-regular--j1-4-see-register-panel.png | not captured | not rated | The demo opens a cashier sheet from the avatar. It shows: sales today; the drawer amount; Pay in · Pay out · Close register; Hand the till to; Switch store / register; Sign out. |
| 09d | Pay in / out | demo: docs D/pos/register/en/tablet-light-regular--j1-5-pay-in.png | not captured | not rated | |
| 09e | Count / close | demo: docs D/pos/reconciliation/en/tablet-light-regular--eod-2-count-the-drawer.png | not captured | not rated | |
| 09f | Closure (Z) | demo: docs D/pos/reconciliation/en/tablet-light-regular--eod-3-file-the-closure.png | not captured | not rated | |
| 10 | Orders | [demo](demo-shots/10-orders-demo-desktop.jpg) | not captured | not rated | The demo has a full-width table with filter pills: Status, Payment Method, Customer, Cashier, Store, Register, Date range. |
| 11 | Customers | [demo](demo-shots/11-customers-demo-desktop.jpg) | none (no screen) | gap | 1. No Customers screen anywhere in navigation; customers are reachable only from the cart picker (`app`). |
| 12 | Products | [demo](demo-shots/12-products-demo-desktop.jpg), demo: docs D/products/en/tablet-light-regular--p1-1-products-list.png | none (no screen) | gap | 1. No Products screen for stock and price edits; editing happens in Medusa Admin (`app`, `plugin`). |
| 13 | Reports | [demo](demo-shots/13-reports-demo-desktop.jpg) (wasm blocked by the capture guard), demo: docs D/reports/index/en/tablet-light-regular--r1-1-see-sales.png | not captured | not rated | The demo has: store/register scope and period menus; figure cards; top products; Print summary. |
| 13b | Closure history | demo: docs D/reports/reconciliation/en/tablet-light-regular--rc-1-closures.png | not captured | not rated | |
| 14a | Navigation (rail / header) | [demo](demo-shots/01-pos-empty-cart-demo-desktop.jpg) | [medusapos](demo-shots/01-pos-empty-cart-medusapos-desktop.jpg) | gap | 1. A text-link header (Orders, Reports, Settings, Sign out) instead of a persistent icon rail with POS, Products, Orders, Coupons, Customers, Reports, Health, Settings, Support (`app`). 2. The screen title reads "Products" on the selling screen (`app`). |
| 14b | User menu | [demo](demo-shots/14-user-menu-demo-desktop.jpg) | none | gap | 1. No avatar or user sheet. Sign out is a bare header link, and there is no "your sales today", drawer summary, hand-over or switch store (`app`, `TU components RegisterPanel`). |
| 14c | Notifications | [demo](demo-shots/14-notifications-demo-desktop.jpg) | none | N/A | WCPOS notification service. Medusa has no cashier inbox; the Medusa way is Admin notifications. |
| 14d | Online / sync status | [demo](demo-shots/01-pos-empty-cart-demo-desktop.jpg) (footer count + sync icon) | [medusapos](demo-shots/01-pos-empty-cart-medusapos-desktop.jpg) | close | 1. Status is text ("Medusa Store · Up to date · 5 products", "Sales are up to date."); the demo shows a count with a tap-to-sync icon in the footer (`TU components ConnectorStatus`). |
| 14e | Store health | [demo](demo-shots/14-store-health-demo-desktop.jpg) | none | N/A | WordPress/WooCommerce plugin health. Medusa's own way is the Admin and server health endpoint. |
| 14f | Support | [demo](demo-shots/14-support-demo-desktop.jpg) | none | N/A | WCPOS product support chat. |
| 15a | Settings, general | [demo](demo-shots/15-settings-general-demo-desktop.jpg) | not captured | not rated | The demo has a left sub-nav (General, Tax, Printing, Card readers, Customer Display, Barcode Scanning, Theme). MedusaPOS has one page with Store / Register / Scanner groups (seen in earlier runs, not shot here). |
| 15b | Settings, tax | [demo](demo-shots/15-settings-tax-demo-desktop.jpg) | none | N/A | Medusa sets tax per region in Medusa Admin; the till shows the region chosen at setup. |
| 15c | Settings, printing | [demo](demo-shots/15-settings-printing-demo-desktop.jpg) | not captured | not rated | |
| 15d | Settings, card readers | [demo](demo-shots/15-settings-card-readers-demo-desktop.jpg) | not captured | not rated | |
| 15e | Settings, customer display | [demo](demo-shots/15-settings-customer-display-demo-desktop.jpg) | not captured | not rated | |
| 15f | Settings, barcode scanning | [demo](demo-shots/15-settings-barcode-scanning-demo-desktop.jpg) | not captured | not rated | |
| 15g | Settings, theme | [demo](demo-shots/15-settings-theme-demo-desktop.jpg) | not captured | not rated | |
| 16 | Sign-in / connect | [demo](demo-shots/16-sign-in-demo-desktop.jpg), demo: docs D/getting-started/connect/en/tablet-light-regular--c1-5-sign-in.png | [sign in](demo-shots/16-sign-in-medusapos-desktop.jpg), [till setup](demo-shots/16-till-setup-region-medusapos-desktop.jpg) | N/A | WordPress login and store connect are Woo-only. Medusa's own way is email and password against Medusa auth, then a till setup that picks the region (currency and tax). |
| 17a | Phone, POS | demo: docs D/pos/index/en/phone-light-regular--pos-3-phone-till.png | not captured | not rated | |
| 17b | Phone, menu | demo: docs D/pos/index/en/phone-light-regular--pos-2-menu.png | not captured | not rated | |
| 17c | Phone, tender | demo: docs D/pos/checkout/en/phone-light-regular--j2-5-take-cash.png | not captured | not rated | |
| 18 | Coupons | [demo](demo-shots/18-coupons-demo-desktop.jpg), demo: docs D/coupons/applying-coupons/en/tablet-light-regular--c-1-coupon-list.png | none | gap | 1. No coupon or promotion-code entry in the cart and no coupons screen. The Medusa way is promotions with codes, applied to the cart (`app`, `plugin`). |

## Not captured

These were not captured before the 3-hour limit:
- the MedusaPOS desktop run, which stopped after 06c;
- the demo phone run, which never got the shared test slot.

The rows marked `not rated` (07, 09c–09f, 10, 13, 13b, 15a, 15c–15g, 17a–17c) need a rerun of the MedusaPOS capture before they can be rated. Their demo or docs reference is already linked.

Demo states not reachable read-only, with no docs screenshot:
- the open-register float form (09b, docs page only);
- the variant chooser (02c, it does not open in price-check mode).

## Top 15 gaps a cashier notices first

1. Cart lines are tall blocks with −/+/Remove buttons, not the compact QTY / ITEM / PRICE / TOTAL table (`TU components Cart`).
2. No full tender pane with a keypad; payment is a small form in the cart column behind Cash / Card buttons (`TU components Tender`, `TU components CashTendered`).
3. No open-orders tab strip; parked sales hide in a modal and need an explicit "Park this sale" (`TU components Cart`, `app`).
4. No navigation rail; a text header with only Orders, Reports, Settings and Sign out (`app`).
5. Product tiles have no images (`TU components ProductCard`, `app`).
6. No single "Checkout €total" button (`TU components Cart`).
7. Qty and price edits use an inline form, not a keypad popover with quick discount keys (`TU components Cart`, `TU components QuantityStepper`).
8. No cart "+" menu; no miscellaneous (custom) product line (`TU components Cart`, `plugin`).
9. No Customers screen (`app`).
10. No coupon or promotion-code entry (`app`, `plugin`).
11. No avatar or user sheet with sales today, drawer amount, hand the till over, switch store or register (`app`, `TU components RegisterPanel`).
12. No filter pills (In Stock, Featured, On Sale, Tag, Brand) beside search (`TU components FilterChipGroup`, `app`).
13. The customer appears as plain "Customer: Guest" text and the picker is a centred modal, not an avatar chip with a drop-down search (`TU components CustomerPicker`, `TU components Cart`).
14. No Products screen for quick stock and price edits (`app`, `plugin`).
15. No product display or cart settings (tile size, browse by, sort, cart side, quick discount values, columns, auto receipt) (`app`, `TU components ProductGrid`).
