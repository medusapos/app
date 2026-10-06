#!/usr/bin/env bash
# Seed an empty migrated demo; safe to re-run. Run inside the demo container.
set -euo pipefail

cd /src/app/dev/medusa-store/apps/backend/.medusa/server
for seed in seed-tax-rates seed-e2e seed-demo-showcase seed-demo-presentation; do
  /src/app/dev/medusa-store/node_modules/.bin/medusa exec "./src/scripts/$seed.js"
done

seed_user() {
  local existing
  existing=$(psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -v email="$1" <<'SQL'
SELECT 1 FROM "user" WHERE email = :'email' AND deleted_at IS NULL;
SQL
  )
  if [[ "$existing" != 1 ]]; then
    /src/app/dev/medusa-store/node_modules/.bin/medusa user -e "$1" -p "$2"
  fi
}
seed_user cashier@demo.medusapos.com demo1234
seed_user manager@demo.medusapos.com demo1234
if [[ -n "${DEMO_ADMIN_EMAIL:-}" ]]; then
  : "${DEMO_ADMIN_PASSWORD:?DEMO_ADMIN_PASSWORD must be set and non-empty when DEMO_ADMIN_EMAIL is set}"
  seed_user "$DEMO_ADMIN_EMAIL" "$DEMO_ADMIN_PASSWORD"
fi
