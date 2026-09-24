# Hosted demo backend

A shared Medusa backend for testers of `https://app.medusapos.com`: this
repo's dev store (`dev/medusa-store`) with the POS plugin, hosted on Paul's
Coolify. Why and how it is set up: [ADR 0006](../../docs/adr/0006-demo-backend-coolify.md).

| | |
|---|---|
| Backend URL | `https://medusapos-demo.213.239.218.130.sslip.io` |
| Admin dashboard | `https://medusapos-demo.213.239.218.130.sslip.io/app` |
| Admin sign-in | keychain on the agent host: `security find-generic-password -s medusapos-demo` (account = email, `-w` prints the password) |
| Coolify | project `medusapos`, environment `production`: application `medusapos-demo-backend`, `medusapos-demo-postgres`, `medusapos-demo-redis` |

Testers sign in to the app with the backend URL and the admin email and
password; there is no MFA.

## Files

- `Dockerfile` builds from the repo root: TallyUI types at the pinned
  `TALLYUI_REF`, the plugin tarball, the dev store, then `medusa build`.
- `start.sh` is the container command: migrations, then `medusa start` on
  port 9000. On an empty database the migrations also run the starter's
  `initial-data-seed` (store, Europe region, sales channel, Copenhagen
  warehouse, shipping options).
- `seed.sh` is the one-off demo data seed (see below).

## Deploy

Coolify builds the branch set on the application (`main`) with
`deploy/demo-backend/Dockerfile`. Deploys are manual: the Deploy button in
Coolify, or `POST /api/v1/deploy?uuid=<application uuid>` with the Coolify API
token.

Runtime environment, set on the application in Coolify as runtime-only
variables (not build variables): `DATABASE_URL` (internal Postgres URL plus
`?sslmode=disable`), `REDIS_URL`, `JWT_SECRET`, `COOKIE_SECRET`,
`STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS`.

## Seed

Run once after the first deploy on an empty database, on the VPS as root:

```sh
docker ps --filter name=<application uuid> --format '{{.Names}}'
docker exec -e DEMO_ADMIN_EMAIL=<email> -e DEMO_ADMIN_PASSWORD=<password> \
  <container> /src/app/deploy/demo-backend/seed.sh
```

It adds the dev store catalogue (about 2,000 products, customers and past
orders), the Europe VAT rates and the five `E2E-*` fixture products, then
creates the admin user. Every seed only fills in what is missing, so it can
be re-run; leave out `DEMO_ADMIN_EMAIL` on a re-run, because the user exists.

## CORS

`STORE_CORS` is `https://app.medusapos.com,http://localhost:8081`.
`ADMIN_CORS` and `AUTH_CORS` are the same plus the backend's own origin (for
the admin dashboard). The POS signs in through `AUTH_CORS` and the plugin's
`/tally/v1/commands` uses `ADMIN_CORS`. To add an origin, edit the variables
in Coolify and redeploy (a restart is enough).

## Verify

From the repo root, with dependencies and Playwright Chromium installed, run
the e2e smoke spec from the hosted app against this backend:

```sh
E2E_APP_URL=https://app.medusapos.com \
E2E_BACKEND_URL=https://medusapos-demo.213.239.218.130.sslip.io \
E2E_EMAIL=<email> E2E_PASSWORD=<password> \
  ./node_modules/.bin/playwright test -c e2e/playwright.config.ts smoke.spec.ts
```

Each run sells one `E2E-1` and one `E2E-4`. Do not run `offline.spec.ts`
against the demo: it needs `E2E-5` to start at 2.

## Rebuild from scratch

Stop the application, delete and recreate the Postgres resource in the
`medusapos` project (update `DATABASE_URL`), deploy, then seed again. Nothing
in the demo is kept.
