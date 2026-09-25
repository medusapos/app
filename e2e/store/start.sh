#!/usr/bin/env bash
set -euo pipefail

BACKEND_PORT="${E2E_BACKEND_PORT:-9100}"
APP_PORT="${E2E_APP_PORT:-8099}"
DATABASE="${E2E_DATABASE:-medusapos_e2e}"
export npm_config_cache="$PWD/e2e/.tmp/npm-cache"
export npm_config_offline=true npm_config_update_notifier=false
export XDG_CONFIG_HOME="$PWD/e2e/.tmp/xdg"
export MEDUSA_DISABLE_TELEMETRY=true
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
mkdir -p "$PWD/e2e/.tmp"
root="$PWD"
(
  cd packages/medusa-plugin
  npm run build
  npm pack --pack-destination "$root/e2e/.tmp"
)
(
  cd dev/medusa-store
  npm install --no-save --offline --no-audit --no-fund "$root/e2e/.tmp/medusapos-medusa-plugin-0.0.1.tgz"
)

export PGUSER="${DB_USERNAME:-claude}"
export PGPASSWORD="${DB_PASSWORD:-}"
export PGHOST="${DB_HOST:-localhost}"
export PGPORT=5432
export PGDATABASE="$DATABASE"
dropdb -U "$PGUSER" -h "$PGHOST" --if-exists "$DATABASE"
createdb -U "$PGUSER" -h "$PGHOST" "$DATABASE"
export DATABASE_URL="$(node -e 'const e = process.env; const u = new URL(`postgres://localhost:5432/${e.PGDATABASE}`); u.username = e.PGUSER; u.password = e.PGPASSWORD; u.hostname = e.PGHOST; process.stdout.write(u.href)')"
export TALLY_E2E_PLUGIN=1
export JWT_SECRET=e2e-jwt-secret COOKIE_SECRET=e2e-cookie-secret
export STORE_CORS="http://localhost:$APP_PORT" ADMIN_CORS="http://localhost:$APP_PORT" AUTH_CORS="http://localhost:$APP_PORT"
cd dev/medusa-store/apps/backend
# The starter migration script seeds its own catalogue; use only our seed.
npx medusa db:migrate --skip-scripts
npx medusa db:migrate:search
npx medusa exec ./src/scripts/seed-e2e.ts
npx medusa user -e e2e@tally.test -p e2e-password
exec npx medusa develop --port "$BACKEND_PORT"
