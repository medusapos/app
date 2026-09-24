# Hosted demo backend on Coolify

Status: Accepted
Date: 2026-09-24

## Context

Testers should be able to try `https://app.medusapos.com` without running
Medusa themselves. The app needs an HTTPS Medusa 2.21 backend with the POS
plugin, demo catalogue data, tax, a stock location with a shipping option,
an admin user without MFA, and CORS that allows the app's origin
(`docs/QUICKSTART.md`).

Paul already runs a Coolify (v4) instance on his Hetzner VPS. Its existing
project `WCPOS` hosts production services and must not be affected by a demo.

## Decision

- **Where:** a separate Coolify project, `medusapos`, on the same Hetzner VPS
  (Coolify API v1). It holds three resources in its `production` environment:
  the application `medusapos-demo-backend`, a Postgres 17 database
  (`medusapos-demo-postgres`) and Redis 7.2 (`medusapos-demo-redis`). Neither
  database is published to the internet; the app reaches them on Coolify's
  internal Docker network.
- **What runs:** this repo's dev store (`dev/medusa-store`, Medusa 2.21.0)
  with the plugin built from `packages/medusa-plugin` at the same commit,
  as a production build (`medusa build`, then `medusa start`). The image is
  `deploy/demo-backend/Dockerfile`, built by Coolify from the GitHub repo with
  the repo root as the build context. It fetches TallyUI's command types at
  the `TALLYUI_REF` pinned in `.github/workflows/ci.yml`, like
  `scripts/vercel-install.sh`. The container runs migrations on every start
  (`deploy/demo-backend/start.sh`); an empty database therefore gets the
  starter's store, Europe region, sales channel, the Copenhagen warehouse and
  shipping options from the `initial-data-seed` migration script.
- **Demo data:** seeded once by `deploy/demo-backend/seed.sh`, run inside the
  running container: the dev store's deterministic catalogue
  (`seed-dev-store`, about 2,000 products, customers and historical orders),
  the Europe VAT rates (`seed-tax-rates`, DK 25% at the Copenhagen warehouse)
  and the five `E2E-*` fixture products (`seed-e2e`), so the repo's e2e smoke
  spec can run against the hosted store. `seed-e2e` reuses the stock location
  already linked to the sales channel, keeping one location per channel. Each
  seed only fills in what is missing, so the script is safe to re-run.
- **Admin user:** one, created by `seed.sh` from `DEMO_ADMIN_EMAIL` and
  `DEMO_ADMIN_PASSWORD` passed to that one `docker exec`. The credentials
  live only in Paul's login keychain on the agent host (service
  `medusapos-demo`), never in the repo or in Coolify's stored environment.
- **Configuration outside the repo:** the application's environment in Coolify:
  `DATABASE_URL` and `REDIS_URL` (Coolify's internal URLs), generated
  `JWT_SECRET` and `COOKIE_SECRET`, and the CORS lists. `STORE_CORS` is
  `https://app.medusapos.com,http://localhost:8081`; `ADMIN_CORS` and
  `AUTH_CORS` add the backend's own origin for the admin dashboard.
- **Domain:** for now the Coolify-provided
  `https://medusapos-demo.213.239.218.130.sslip.io`, with a Let's Encrypt
  certificate from Coolify's Traefik (HTTP-01). A custom domain such as
  `demo-api.medusapos.com` is a later step: a Squarespace DNS record (web
  dashboard only), then a Coolify domain change and a CORS update.
- **Branch:** Coolify builds `main`; deploys are manual (the Coolify deploy
  button or API), not on every push.

## Consequences

- The demo is shared by every tester. Sales change its stock and orders;
  anyone with the admin credentials can change anything. It holds no real
  customer data and can be rebuilt: delete and recreate the Postgres resource,
  redeploy, and run `seed.sh` again.
- Each e2e smoke run against the demo sells one `E2E-1` and one `E2E-4`
  (seeded with 50 each). The offline spec needs `E2E-5` to start at 2, so it
  only runs against a fresh store, never the demo.
- The demo runs on the same VPS as WCPOS production services. It is one
  Node process plus a small Postgres and Redis; the host has ample headroom,
  but a runaway demo competes for the same CPU and memory.
- Medusa runs with `redisUrl` only (sessions); its event bus, cache and
  workflow engine stay in-memory, which is fine for a single demo instance but
  not a production setup.
- The runbook for rebuilding, reseeding and changing CORS is
  `deploy/demo-backend/README.md`.
