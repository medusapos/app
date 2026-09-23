# MedusaPOS tester quick-start

MedusaPOS is a browser point of sale for your Medusa store. The MVP supports
cash sales and payments taken on a separate card terminal, recorded as external
payments. It includes offline selling: every sale lands in your Medusa store
exactly once, paid and with stock decremented, when it syncs successfully.
The POS does not charge cards itself.

## What you need

- A Medusa 2.21 store and access to its configuration.
- An admin user's email and password, without multi-factor authentication (MFA).
- An HTTPS backend URL. For local testing, `http://localhost:9100` or
  `http://127.0.0.1:9100` also works; use your store's port. An HTTPS POS cannot
  connect to a plain-HTTP backend on another machine.
- The hosted app URL shared with you (initially a `*.vercel.app` URL, later
  `https://app.medusapos.com`) and one browser tab for the POS.

## Install the plugin

In your Medusa store's directory, run:

```sh
npm install https://github.com/medusapos/app/releases/download/plugin-v0.0.1/medusapos-medusa-plugin-0.0.1.tgz
```

Add this entry to the `plugins` list in `medusa-config.ts`, keeping any existing
plugins:

```ts
plugins: [{ resolve: '@medusapos/medusa-plugin', options: {} }]
```

You can set these optional IDs inside `options`:

- `salesChannelId`: the sales channel for POS orders; otherwise the store's
  default sales channel is used.
- `locationId`: the stock location for POS orders; otherwise the channel's
  first linked stock location is used.
- `shippingOptionId`: the shipping option for POS orders; otherwise the
  location's earliest shipping option is used.

Then apply the plugin's database migrations and restart your Medusa backend:

```sh
npx medusa db:migrate
```

## Configure your store

1. Add the POS origin to both `ADMIN_CORS` and `AUTH_CORS`, keeping existing
   origins. An origin is the app's scheme and hostname (and port if present),
   without a path or trailing slash: for example, `https://your-pos.vercel.app`.
   Use the actual hosted app URL you received, then restart the backend.
2. Make sure the default sales channel has a stock location with an address.
   Tax follows that address. If you set `salesChannelId` or `locationId`,
   configure the selected channel and location instead.
3. Create a shipping option at that location, such as in-store pickup, or set
   the plugin's `shippingOptionId` to the option you want to use.
4. Configure tax rates for the location's country. Prices include or exclude
   tax according to your currency's price preference in Medusa.

## Sign in

Open the hosted app URL. Enter your backend URL, admin email and password,
then sign in. Let the catalogue load while you are online before selling
offline. Keep just one POS tab open in this browser.

## Make a sale

Scan a barcode or search for a product, add items and check the quantities.
Choose **Cash** or **Card terminal**. For a card sale, take the payment on
your separate terminal; the POS records that external payment. Complete the
sale, then view the receipt and print it if needed.

You can keep selling from the loaded catalogue if the connection drops.
The sync bar shows sales waiting to sync and confirms when they have synced.
Reconnect to send queued sales to Medusa.

Open **Orders** to review sales and their sync status. **Needs attention**
means an order was rejected or has a warning, such as stock being short.
Read the order's details: a warning can accompany a successfully synced sale,
while a rejected order needs investigation.

## Known MVP limits

- Use one POS tab per browser. The queue of unsynced sales (the outbox) supports
  only one tab.
- Discounts are not supported.
- A product deleted in Medusa stays in the POS catalogue until you sign out
  and back in. Signing out clears the local catalogue.
- Medusa keeps line tax unrounded, so its reports can differ from receipts by
  fractions of a cent. The payment always equals the POS total.
- Use one stock location per sales channel. With several locations, Medusa
  may reserve stock at another location.
- Stock may go negative when an offline sale oversells it. The order shows a
  warning so you can review the shortfall.
- Multi-factor sign-in is not supported.

## Troubleshooting

- **CORS errors:** check that both `ADMIN_CORS` and `AUTH_CORS` include the
  exact origin you opened, including HTTPS and any port. Restart the backend
  after changing them.
- **"Missing shipping option":** configure a shipping option at the POS stock
  location, or set `shippingOptionId` in the plugin options and restart.
- **Sign-in says "not supported yet":** multi-factor sign-in is not supported;
  use an admin account with email/password sign-in and no MFA.
- **Sales stuck "waiting to sync":** check your internet connection and that
  the backend is reachable. Open **Orders** for each sale's status and any
  rejection or warning details.
