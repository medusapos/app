#!/usr/bin/env bash
# Restore the demo database from its golden copy, then stop PID 1 to restart.
# Coolify scheduled task mpdemo-nightly-reset runs: docker exec <container> /src/app/deploy/demo-backend/reset.sh
# Golden database is made once after seeding: CREATE DATABASE medusapos_demo_golden TEMPLATE medusapos_demo
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

admin_url=$(printf '%s' "$DATABASE_URL" | sed -E 's#^([^/]*//[^/]*)/[^?]*#\1/postgres#')

if [[ $(psql "$admin_url" -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_database WHERE datname = 'medusapos_demo_golden'") != 1 ]]; then
  echo 'reset.sh: medusapos_demo_golden not found; nothing changed' >&2
  exit 1
fi

psql "$admin_url" -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS medusapos_demo WITH (FORCE)' \
  -c 'CREATE DATABASE medusapos_demo TEMPLATE medusapos_demo_golden'

echo 'reset.sh: medusapos_demo recreated from medusapos_demo_golden; stopping PID 1 to restart the container'
kill -TERM 1
