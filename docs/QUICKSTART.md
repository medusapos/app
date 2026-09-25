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
  `http://127.0.0.1:9100` also works; use your store's port. Chrome then asks
  to let the POS access devices on your local network: choose **Allow**, or
  sign-in reports that it could not reach the backend. An HTTPS POS cannot
  connect to a plain-HTTP backend on another machine.
- The hosted app, `https://app.medusapos.com`, in a current Chrome, Edge,
  Safari or Firefox, over HTTPS or on `localhost`. MedusaPOS keeps sales and
  the catalogue in the browser's own private storage; exactly one tab per
  store stays live at a time — see the [tester guide](testers.md#try-it) for
  what a second tab does.

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

1. Add the POS origin `https://app.medusapos.com` to both `ADMIN_CORS` and
   `AUTH_CORS`, keeping existing origins. Write it exactly like that, without
   a path or trailing slash, then restart the backend.
2. Make sure the default sales channel has a stock location with an address.
   Tax follows that address. If you set `salesChannelId` or `locationId`,
   configure the selected channel and location instead.
3. Create a shipping option at that location, such as in-store pickup, or set
   the plugin's `shippingOptionId` to the option you want to use.
4. Configure tax rates for the location's country. Prices include or exclude
   tax according to your currency's price preference in Medusa.
5. Create (or reuse) a publishable API key linked to your sales channel: in
   the Medusa admin, go to **Settings → Publishable API Keys**, then add your
   sales channel under that key's **Sales channels** tab. MedusaPOS needs
   this to price your catalogue and to see what the channel sells — see the
   [tester guide](testers.md#set-up-this-till) for the till's region and
   channel choice on first sign-in.
6. If you do not have an admin user without MFA, create one from your store's
   backend directory, replacing the email and password below with your own:

   ```sh
   npx medusa user -e you@example.com -p '<a strong password>'
   ```

   The POS signs in with that email and password.

## Sign in

Open `https://app.medusapos.com`. Enter your backend URL, admin email and
password, then sign in. If your store has more than one region or
publishable key, you're asked to choose them first — see the
[tester guide](testers.md#set-up-this-till). Let the catalogue load while
you are online before selling offline.

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
- **Sign-in says "Could not reach the backend":** check the backend URL and
  that the backend is running. With a `localhost` backend, Chrome also needs
  the POS's permission to access your local network: allow it from the
  prompt, or from the site settings (the icon left of the address bar).
- **"Missing shipping option":** configure a shipping option at the POS stock
  location, or set `shippingOptionId` in the plugin options and restart.
- **Sign-in says "not supported yet":** multi-factor sign-in is not supported;
  use an admin account with email/password sign-in and no MFA.
- **"Storage stopped … Reload":** rare — the device's local storage worker
  died. Reload the tab; sales already saved are kept.
- **"Saving is slow…":** a transient note while a save is taking a moment;
  no action needed.
- **Sales stuck "waiting to sync":** check your internet connection and that
  the backend is reachable. Open **Orders** for each sale's status and any
  rejection or warning details.
