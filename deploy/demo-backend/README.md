# Hosted demo backend

A shared Medusa backend for testers of `https://app.medusapos.com`: this
repo's dev store (`dev/medusa-store`) with the POS plugin, run from a
prebuilt image on Paul's Coolify VPS. Why and how it is set up:
[ADR 0006](../../docs/adr/0006-demo-backend-coolify.md).

| | |
|---|---|
| Backend URL | `https://demo-api.medusapos.com` (until its DNS record exists: `https://mpdemo.213.239.218.130.sslip.io`) |
| Admin dashboard | the backend URL plus `/app` |
| Admin sign-in | keychain on the agent host: `security find-generic-password -s medusapos-demo` (account = email, `-w` prints the password) |
| Image | `ghcr.io/medusapos/demo-backend:<commit sha>` (public) |
| Coolify | project `medusapos-demo`: application `mpdemo-backend` (Docker image), database `mpdemo-postgres` (`postgres:16-alpine`), scheduled task `mpdemo-nightly-reset` |

Testers sign in to the app with the backend URL and the admin email and
password; there is no MFA.

Coolify changes on that server are made only by the front desk or Paul; it
also runs WCPOS production. Never use the images `postgres:17-alpine`,
`redis:7.2`, `mongo:7` or `mariadb:11` there: a host cron gives the newest
container of those images the production network aliases.

## Files

- `Dockerfile` builds from the repo root: TallyUI types at the pinned
  `TALLYUI_REF`, the plugin tarball, the dev store, then `medusa build`.
  It includes `psql` for `reset.sh`.
- `start.sh` is the container command: migrations, then `medusa start` on
  port 9000. On an empty database the migrations also run the starter's
  `initial-data-seed` (store, Europe region, sales channel, Copenhagen
  warehouse, shipping options).
- `seed.sh` is the one-off demo data seed (see below).
- `reset.sh` is the nightly reset (see below).
- `smoke.sh` is CI only: it runs the built image against `postgres:16-alpine`
  with no Redis, checks `/health`, then runs `reset.sh` and checks that the
  container restarts healthy.

## Image

The `Demo backend image` workflow (`.github/workflows/demo-backend.yml`)
builds the image and runs `smoke.sh` on pull requests that touch the backend,
the plugin or this directory. On a push to `main` it also pushes
`ghcr.io/medusapos/demo-backend:<commit sha>`. To deploy a new build, set that
tag on `mpdemo-backend` in Coolify and redeploy. Nothing builds on the VPS.

## No Redis

The demo runs without Redis: leave `REDIS_URL` unset. Medusa 2.21 then logs
`redisUrl not found. A fake redis instance will be used.` and keeps
everything in the Node process: admin sessions (express-session's memory
store, which also logs a "not designed for a production environment"
warning), and Medusa's default in-memory event bus, cache, workflow engine
and locking. Redis-backed modules are only wired in on Medusa Cloud
(`defineConfig` in `@medusajs/utils`). A restart, including the nightly
reset, ends admin dashboard sessions. This suits one demo instance, not a
production store. CI proves the image starts this way (`smoke.sh`).

## Runtime environment

Set on `mpdemo-backend` in Coolify as runtime-only variables:
`DATABASE_URL` (the internal Postgres URL, database `medusapos_demo`, plus
`?sslmode=disable`), `JWT_SECRET`, `COOKIE_SECRET` (both required: in
production Medusa refuses to start without them), `STORE_CORS`,
`ADMIN_CORS`, `AUTH_CORS`. No `REDIS_URL`.

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

Then save the seeded state as the golden copy. Postgres copies a template
only when nobody is connected to it, so stop `mpdemo-backend` first, then in
the `mpdemo-postgres` container:

```sh
psql -U <postgres user> -d postgres -c 'CREATE DATABASE medusapos_demo_golden TEMPLATE medusapos_demo'
```

and start `mpdemo-backend` again.

## Nightly reset

The Coolify scheduled task `mpdemo-nightly-reset` runs
`/src/app/deploy/demo-backend/reset.sh` in `mpdemo-backend` at `17 3 * * *`
(UTC). It checks that `medusapos_demo_golden` exists (and changes nothing if
not), drops `medusapos_demo` with `WITH (FORCE)` (which ends the backend's
connections), recreates it from the golden copy, then sends SIGTERM to PID 1.
The container exits and Docker's restart policy starts it again, running the
migrations. The task may report a failed exit because its `docker exec`
session ends with the container.

To change what the demo resets to, reseed or edit the demo, stop the backend,
drop `medusapos_demo_golden` and create it again as above.

## CORS

`STORE_CORS` is `https://app.medusapos.com,http://localhost:8081`.
`ADMIN_CORS` and `AUTH_CORS` are the same plus the backend's own origin (for
the admin dashboard). The POS signs in through `AUTH_CORS` and the plugin's
`/tally/v1/commands` uses `ADMIN_CORS`. To add an origin, edit the variables
in Coolify and restart the application.

## Verify

From the repo root, with dependencies and Playwright Chromium installed, run
the e2e smoke spec from the hosted app against this backend:

```sh
E2E_APP_URL=https://app.medusapos.com \
E2E_BACKEND_URL=<backend URL> \
E2E_EMAIL=<email> E2E_PASSWORD=<password> \
  ./node_modules/.bin/playwright test -c e2e/playwright.config.ts smoke.spec.ts
```

Each run sells one `E2E-1` and one `E2E-4`; the nightly reset puts them back.
Do not run `offline.spec.ts` against the demo: it needs `E2E-5` to start at 2.
