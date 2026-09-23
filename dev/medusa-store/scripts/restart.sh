#!/usr/bin/env bash
# (Re)starts the dev store: Postgres and Redis (brew services, which also come
# back at login) and the Medusa server on 127.0.0.1:9000. Run after a reboot.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

brew services start postgresql@17 >/dev/null
brew services start redis >/dev/null
stop_store
mkdir -p "$(dirname "$LOG_FILE")"
cd "$MEDUSA_DEV_HOME/apps/backend"
# set -m gives the server its own process group, so stop_store can end it whole.
set -m
nohup npx medusa develop --host 127.0.0.1 --no-lint >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
set +m
wait_for_store
echo "Medusa dev store: http://localhost:9000 (admin: http://localhost:9000/app)"
