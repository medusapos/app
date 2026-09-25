# Testing MedusaPOS

Thanks for testing MedusaPOS. This page is where to start; it links out for
setup detail rather than repeating it.

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
send them.

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

Prices are a snapshot from the last catalogue sync; stock is reconciled on
its own cadence instead — see the README's
[Known limitations](../README.md#known-limitations) section for the full
picture.

## Report a problem

The fastest way: tap **Send feedback**, on the sign-in screen or the Orders
screen, which opens a GitHub issue form in your browser. You can also open
it directly:
`https://github.com/medusapos/app/issues/new?template=tester-feedback.yml`.

The form asks for your app version, backend host, device and browser, what
happened, steps to reproduce and what you expected. The backend URL is
always reduced to its host — never the full URL, path or credentials.
