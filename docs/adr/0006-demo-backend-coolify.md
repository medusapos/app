# Hosted demo backend on Coolify

Status: Accepted
Date: 2026-09-24

## Context

Testers should be able to try `https://app.medusapos.com` without running
Medusa themselves. The app needs an HTTPS Medusa 2.21 backend with the POS
plugin, demo catalogue data, tax, a stock location with a shipping option,
an admin user without MFA, and CORS that allows the app's origin
(`docs/QUICKSTART.md`).

Paul runs a Coolify (v4) instance on his Hetzner VPS, which also hosts WCPOS
production. Paul ruled against a separate server, so the demo runs beside
production and must not be able to affect it. A first attempt on 2026-09-24
took the production Medusa API down: a host cron gives the newest running
container of certain images (`postgres:17-alpine`, `redis:7.2`, `mongo:7`,
`mariadb:11`) the production network aliases, and the demo's Postgres and
Redis used two of those images. The host is also short of CPU and memory, so
building images there is out.

## Decision

- **Where:** Coolify project `medusapos-demo` on the same VPS, resources
  prefixed `mpdemo-`: the application `mpdemo-backend` and the database
  `mpdemo-postgres`, with CPU and memory limits and a low CPU share.
  The database is not published to the internet. No custom network aliases.
- **No Redis.** `REDIS_URL` is unset. Medusa 2.21 then uses its in-memory
  event bus, cache, workflow engine and locking, and an in-process session
  store (it logs `redisUrl not found. A fake redis instance will be used.`).
  That fits a single demo instance; a restart ends admin sessions.
- **Postgres 16** (`postgres:16-alpine`), an image the host cron does not
  match.
- **What runs:** this repo's dev store (`dev/medusa-store`, Medusa 2.21.0)
  with the plugin built from `packages/medusa-plugin` at the same commit, as
  a production build (`medusa build`, then `medusa start`), from
  `deploy/demo-backend/Dockerfile`. The container runs migrations on every
  start (`start.sh`).
- **Image:** GitHub Actions builds the image, runs `smoke.sh` against
  Postgres 16 with no Redis (start, `/health`, nightly reset, restart), and on
  `main` pushes the public `ghcr.io/medusapos/demo-backend:<commit sha>`.
  Coolify pulls a pinned tag with its Docker image build pack. Nothing builds
  on the VPS, and a deploy is a deliberate tag change.
- **Demo data:** seeded once by `seed.sh` inside the running container: the
  dev store's deterministic catalogue, the Europe VAT rates and the five
  `E2E-*` fixture products. The seeded database is then copied to
  `medusapos_demo_golden`.
- **Nightly reset:** a Coolify scheduled task runs `reset.sh`, which
  recreates `medusapos_demo` from the golden copy and stops PID 1 so the
  container restarts. Testers get a clean store every day, and the e2e smoke
  spec's sales are undone.
- **Admin user:** one, created by `seed.sh` from `DEMO_ADMIN_EMAIL` and
  `DEMO_ADMIN_PASSWORD` passed to that one `docker exec`. The credentials
  live only in Paul's login keychain on the agent host (service
  `medusapos-demo`), never in the repo or in Coolify's stored environment.
- **Domain:** `demo-api.medusapos.com` (Squarespace DNS), with Coolify's
  `sslip.io` domain until the record exists.

## Consequences

- The demo is shared by every tester, and anyone with the admin credentials
  can change anything until the next nightly reset. It holds no real
  customer data.
- Changes on the VPS are made by the front desk or Paul, one at a time, with
  a rollback; see `deploy/demo-backend/README.md` for the runbook.
- The demo competes with production for CPU and memory; its limits and low
  CPU share bound that.
- The host cron's image matching is a latent production issue of its own;
  fixing it is a separate, reviewed production change.
