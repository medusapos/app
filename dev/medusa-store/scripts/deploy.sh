#!/usr/bin/env bash
# Installs or updates the dev store from this source tree into
# $MEDUSA_DEV_HOME (default ~/Projects/medusa-dev) and restarts the server.
# Data is untouched; reset.sh rebuilds it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$MEDUSA_DEV_HOME/logs"
rsync -a --delete \
  --exclude node_modules --exclude .medusa --exclude .env --exclude .pos-api-key --exclude logs \
  "$SRC/" "$MEDUSA_DEV_HOME/"
cd "$MEDUSA_DEV_HOME"
npm ci --no-audit --no-fund
[ -f apps/backend/.env ] || cp apps/backend/.env.dev-store apps/backend/.env
"$MEDUSA_DEV_HOME/scripts/restart.sh"
