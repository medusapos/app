# Testing MedusaPOS

Thanks for testing MedusaPOS. This page is where to start; it links out for
setup detail rather than repeating it.

## What changed since your last round

- The till now has a register. Choose **Register 1** and open it with the
  cash in the drawer (the float) before taking payment; you can browse and
  fill the cart before that. The register's state shows under the header
  (on a phone, at the right end of a row); tap it to choose or open the
  register. **Register ›** opens its panel: the sales this session, the
  cash expected in the drawer, and **Paid in**, **Paid out** and **No sale**,
  each with **Undo**.
- You can now close the register. In its panel, **Close register** opens
  the count (on a phone, in the cart view). Tap the note and coin tiles or
  type the cash in the drawer; the line under the amount shows what's
  expected and how far off you are. **Close register** then shows the
  closure number and each tender's counted, expected and difference. After
  **Done**, the open card is filled in with the cash you just counted.
  Between sessions, **Register ›** shows the last closure's figures.
- If the cash is more than €5.00 over or short, closing needs a manager's
  approval: an admin of your Medusa store signs in with their email and
  password in the **Manager approval** box. This doesn't sign you out. On
  your own, you can approve with your own login. The closure then shows
  "Approved by" and their name. Approval needs a connection. Offline, or
  after 15 seconds with no answer, it says "Connect to approve, or count
  again."; **Cancel** (always available) and count again.
  Never save a manager's password in the till's browser. If the browser
  offers to save it after **Approve**, choose "Never" or "Not now". If it
  suggests a generated "strong password" in that field, dismiss it and type
  the manager's own.
- If the till stopped in the middle of a close, the register shows "Close
  not finished"; tap it for "The last close didn't finish." and **Finish
  closing**, which completes it with the count you already entered.
- If saving a sale fails but the order did reach the till's storage, the
  pay screen says "This sale is stored and will be sent" and offers
  **Continue** to start the next sale. Pressing the pay button again to
  retry a failed save never saves the sale twice.
- A sale that went unsent no longer stays stuck in Orders until a reload.
- **Sign out** is greyed out while a sale is saving. If the till is signed
  out automatically (for example, your login expired) during a sale, it
  shows "Signed out after this sale is saved" and signs out once the sale
  and its receipt are done. If an earlier sale is still being saved after
  you pressed **Continue**, the header area says "An earlier sale is still
  being saved." and Sign out waits for it.
- A new **Settings** screen, opened from the header, tunes the barcode
  scanner for this till. Set the average time per key (raise it for slow
  Bluetooth scanners) and the minimum code length. Then scan into **Test
  scan here** to check whether a scan counts.
- If the till can't open its saved sales, it now says so with **Reload**
  and **Report a problem**, instead of failing silently. Nothing is deleted.
- Sales saved before an update carry over when the till upgrades its
  storage. A slow upgrade no longer leaves the till unable to save until
  the browser restarts.
- You can give a discount on a single line or on the whole order, and each
  discount's chip shows the amount actually taken off.
- On a phone, Products has a cart bar pinned to the bottom; open it for a
  full-height cart with the totals and pay buttons always in view.
- The receipt now adds up: each line before its own discount, that line's
  discount underneath it, then the order discount, then Subtotal, Discount,
  VAT and Total.
- A barcode scanner works in the phone cart view as well as on Products.
- The header fits on a phone screen.
- The variant chooser updates live as stock and price change.

## Try it

Open `https://app.medusapos.com` in a current Chrome, Edge, Safari or
Firefox, over HTTPS or on `localhost`. MedusaPOS stores sales and the
catalogue in the browser's own private storage; a browser without it shows
"MedusaPOS can't run in this browser" instead of opening.

Only one tab per store is ever live. Open a second tab and it takes over;
the first shows "MedusaPOS is open in another tab" with a **Use here**
button to take it back. Closing the live tab lets a waiting tab take over on
its own.

## Use the hosted demo store

The hosted demo store is coming soon — check back here for the backend URL
and demo login to sign in at `https://app.medusapos.com` without setting up
your own Medusa store.

<!--
Placeholder for the front desk to fill in when the demo is live:
Backend URL: <TBD>
Email: <TBD>
Password: <TBD>
-->

## Use your own Medusa backend

You'll need:

- A Medusa 2.21 store with the POS plugin installed.
- An admin user's email and password, without multi-factor authentication (MFA).
  If your store has Medusa RBAC on, the user also needs the "POS cashier" or
  "POS manager" role. See QUICKSTART's [Configure your store](QUICKSTART.md#configure-your-store),
  step 7, for how to turn RBAC on and create those roles.
- An HTTPS backend URL — see QUICKSTART's ["What you need"](QUICKSTART.md#what-you-need)
  for when plain `http://` is allowed.

Add the POS origin to your backend's CORS settings, keeping any existing
origins, with no path or trailing slash, in your backend's `.env`, then
restart the backend:

```env
# Append to your existing origins — don't replace them.
ADMIN_CORS=<your existing origins>,https://app.medusapos.com
AUTH_CORS=<your existing origins>,https://app.medusapos.com
```

The POS signs in with your email and password at the backend's
`/auth/user/emailpass`, then sends the returned token as `Authorization:
Bearer` on every request after that. When the token expires, sales keep
queuing on the device and a "Sign in" strip asks for your password again to
send them — see [Sign-in and sync banners](#sign-in-and-sync-banners).

See the [tester quick-start](QUICKSTART.md) for installing the plugin,
configuring your store (sales channel, stock location, shipping option, tax,
a publishable API key) and creating an admin user.

## Set up this till

On first sign-in, MedusaPOS resolves your store's region, tax and sales
channel from Medusa. If your store has more than one region or publishable
API key, you're asked to pick them on a "Set up this till" screen; the
till's country always follows its stock location's country, so it's never
offered as a choice. If the region you pick doesn't cover that country, the
till says so ("Stock location … is in …, which region … does not cover.")
and lets you choose another. The choice is remembered for this store.

Prices shown are Medusa's own calculated prices for your chosen region, sale
prices included; products your sales channel doesn't sell are hidden.

## On a phone

Below 600 px wide — most phones — MedusaPOS switches to a single,
full-height view instead of showing products and the cart side by side:

- **Products** shows the catalogue with a cart bar pinned to the bottom, for
  example "Cart · 2 items €5.00 ›". Tap it to open the cart.
- The **cart** view shows "‹ Products" at the top to go back. Its totals and
  the Cash / Card terminal buttons stay in view at the bottom while the
  lines scroll above them.
- Adding a product keeps you on Products, so you can scan or tap several
  products in a row before opening the cart to check out.

![Products, with the cart bar reading "Cart · 2 items" at the bottom](testers/products-cart-bar.png)

## Scanning barcodes

- With a USB or Bluetooth barcode scanner set to type like a keyboard, scan
  on **Products**: the search box takes the code the same as if you'd typed
  it.
- Scanning also works from the phone **cart** view, so you don't need to go
  back to Products first. An unknown code shows `No product matches "…"`
  instead of adding anything.
- Typing into a discount box is never read as a scan, so entering a discount
  value there is never mistaken for a barcode.
- **Settings → Scanner** holds this till's minimum characters and average
  time per key, for a scanner that types slower or codes shorter than the
  defaults expect. Its **Test scan here** field shows the last scan's
  average and whether it would count, against these same values, without
  going to Products or the cart to check. The minimum applies to the
  Products search box too: shorter text followed by Enter stays a search.
- Camera scanning isn't available yet — see
  [Known limitations](#known-limitations).

![The cart view showing "No product matches "ZZZ-NOPE"" after an unknown scan](testers/scan-miss.png)

## Discounts

Give a line a discount from its **Discount** action; give the whole order a
discount from the **Order discount** button below the lines. Either way:
choose **Percent** or **Amount**, enter the value, then **Apply**.

![A line's discount form open, with Percent selected and "10" entered](testers/discount-form.png)

To remove a discount, tap its chip (the ✕). Each chip shows what actually
came off, not what you typed: a percent line discount reads, for example,
"10% −€0.40"; a fixed discount reads "−€0.40"; the order discount reads
"Order discount −€0.50".

![The cart with a 10% line discount chip and an order discount chip, and the totals pinned at the bottom](testers/cart-discounts.png)

A discount can never take more off than the line, or the order, is worth —
MedusaPOS refuses it rather than show a negative price. If your store
doesn't yet support discounts, applying one is refused too, and the app
says so in the discount form instead of adding it.

## The receipt

Each line lists before any discount, as quantity × unit price. Its own
discount, if it has one, is a row underneath. Below the lines, an order
discount (if any) gets its own row. Then Subtotal, Discount, VAT (or
"incl. VAT" if your store's prices include tax) and Total.

For example, selling 2 of a €2.00 product with 10% off the line and €0.50
off the whole order:

- 2 × €2.00: €4.00
- 10% off: −€0.40
- Order discount: −€0.50
- Subtotal: €4.00
- Discount: −€0.90
- VAT 25%: €0.78
- Total: €3.88

Subtotal is every line before its own discount, added up. Discount is every
discount added together. VAT is worked out on what's left after discounts.
Total is Subtotal − Discount + VAT, or Subtotal − Discount if your store's
prices already include tax.

![The receipt for the worked example above, with cash tendered and change](testers/receipt.png)

## Sign-in and sync banners

A banner can appear at the top of the screen while a sale can't reach the
store yet:

- **Sign in again**: if your sign-in has expired, a strip says your sales
  are saved and waiting to send, with a **Sign in** link — enter your
  password there to send them.
- **Not accepted**: if the store refuses a whole batch of sales, a banner
  says how many aren't accepted, with **Details** and a **Try again**
  button once the store's fixed — see
  [Orders that need attention](#orders-that-need-attention).
- **Waiting to sync**: while a sale hasn't reached the store yet, Products
  shows how many sales are waiting to sync, and Orders lists each one as
  "Waiting to sync" — see [Offline](#offline).
- **Saved sales can't be opened**: if the sales saved on this device fail
  to open, a full-screen message blocks the till — "Saved sales can't be
  opened on this device. Nothing has been deleted. Reload to try again, or
  report the problem." — with a **Reload** button, a **Report a problem**
  link, and, if there is one, an error code shown in small text underneath.

## Offline

You can keep selling from the catalogue already loaded on the device: a
sale queues on the device and is listed under **Orders** as "Waiting to
sync"; it's sent to Medusa exactly once when you're back online.

You do need a connection for your first sign-in and for the initial
catalogue load — let the catalogue load while online before you start
selling offline. After that, your store settings are cached, so the till
opens offline too (an "Offline" note with **Retry** while it can't reach the
store).

There's no offline page cache (no service worker), so reloading or
reopening the app while offline fails. Once the app is open, a reload while
you're online keeps any sales still waiting to sync.

## Orders that need attention

Open **Orders** → **Needs attention** to see sales that need a look:

- A sale the store rejected shows a **Retry** button, which sends it again.
- Some rejections instead say the sale needs checking against the store
  before it can be sent again — there's no Retry for those; check the sale
  against the store first.
- A "*N* sales not accepted · Details" strip at the top of the screen means
  the store is refusing the whole batch: those sales stay safely on the
  register, and **Try again** resends them once the store is fixed.

## Known limitations

- Prices are re-checked every 30 minutes, and base prices nightly, so they
  are not live to the second; stock is reconciled on its own cadence — see
  the README's [Known limitations](../README.md#known-limitations) section
  for the full picture.
- Camera scanning isn't available yet — use a USB or Bluetooth barcode
  scanner set to type like a keyboard instead (see
  [Scanning barcodes](#scanning-barcodes)).
- If an order appears twice in **Orders**, report it; a fix is in this
  release.
- If a sale stays "Waiting to sync" while you're online, reload the app and
  report it; a fix is in this release.
- If a sale can't be saved, the payment screen stays on it and **Complete
  sale** tries again. Once the app confirms the sale is saved on this till,
  **Continue** appears: it starts the next sale, and the saved sale is sent
  as usual. **Sign out** stays greyed out until the sale is saved or you
  continue. If it keeps failing and **Continue** never appears, write the
  sale down, reload the app and report it.

## Report a problem

The fastest way: tap **Send feedback**, on the sign-in screen or the Orders
screen, which opens a GitHub issue form in your browser. You can also open
it directly:
`https://github.com/medusapos/app/issues/new?template=tester-feedback.yml`.

The form asks for your app version, backend host, device and browser, what
happened, steps to reproduce and what you expected. The backend URL is
always reduced to its host — never the full URL, path or credentials.
