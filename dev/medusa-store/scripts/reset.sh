#!/usr/bin/env bash
# Rebuilds the dev store's data from scratch: drops the database, migrates,
# seeds (deterministic), creates the admin user and the POS API key.
# Run deploy.sh once first.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$MEDUSA_DEV_HOME/apps/backend"

brew services start postgresql@17 >/dev/null
brew services start redis >/dev/null
stop_store

dropdb -h localhost --if-exists "$DB_NAME"
createdb -h localhost "$DB_NAME"
npx medusa db:migrate
npx medusa db:migrate:search
npx medusa exec ./src/scripts/seed-dev-store.ts
npx medusa exec ./src/scripts/seed-tax-rates.ts
npx medusa user -e "$ADMIN_EMAIL" -p "$ADMIN_PASSWORD"
POS_API_KEY_FILE="$MEDUSA_DEV_HOME/.pos-api-key" npx medusa exec ./src/scripts/create-pos-api-key.ts

"$MEDUSA_DEV_HOME/scripts/restart.sh"
echo "Admin login: $ADMIN_EMAIL / $ADMIN_PASSWORD. POS key: $MEDUSA_DEV_HOME/.pos-api-key"
