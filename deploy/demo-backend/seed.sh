#!/usr/bin/env bash
# One-off demo data seed, run inside the running container:
# docker exec <container> /src/app/deploy/demo-backend/seed.sh
# Safe to re-run because every seed only fills in what is missing.
set -euo pipefail

cd /src/app/dev/medusa-store/apps/backend/.medusa/server
/src/app/dev/medusa-store/node_modules/.bin/medusa exec ./src/scripts/seed-dev-store.js
/src/app/dev/medusa-store/node_modules/.bin/medusa exec ./src/scripts/seed-tax-rates.js
/src/app/dev/medusa-store/node_modules/.bin/medusa exec ./src/scripts/seed-e2e.js

if [[ -n "${DEMO_ADMIN_EMAIL:-}" ]]; then
  : "${DEMO_ADMIN_PASSWORD:?DEMO_ADMIN_PASSWORD must be set and non-empty when DEMO_ADMIN_EMAIL is set}"
  /src/app/dev/medusa-store/node_modules/.bin/medusa user -e "$DEMO_ADMIN_EMAIL" -p "$DEMO_ADMIN_PASSWORD"
fi
