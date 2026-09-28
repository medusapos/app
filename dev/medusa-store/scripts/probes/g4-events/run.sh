#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bus="${1:?Usage: run.sh <local|redis> <out-dir>}"
case "$bus" in
  local|redis) ;;
  *) echo "Expected local or redis" >&2; exit 1 ;;
esac
mkdir -p "${2:?Usage: run.sh <local|redis> <out-dir>}"
out_dir="$(cd "$2" && pwd)"
export npm_config_cache="$out_dir/npm-cache"
export npm_config_offline=true npm_config_update_notifier=false
export XDG_CONFIG_HOME="$out_dir/xdg"
export MEDUSA_DISABLE_TELEMETRY=true
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
export PGUSER=claude PGPASSWORD= PGHOST=localhost PGPORT=5432 PGDATABASE=medusapos_g4
export DATABASE_URL="postgres://claude@localhost:5432/medusapos_g4"
export JWT_SECRET=g4-jwt-secret COOKIE_SECRET=g4-cookie-secret
export STORE_CORS="http://localhost:9200"
export ADMIN_CORS="http://localhost:9200"
export AUTH_CORS="http://localhost:9200"
unset TALLY_E2E_PLUGIN G4_EVENT_BUS G4_REDIS_URL G4_EVENT_PROBE_FILE
mkdir -p "$XDG_CONFIG_HOME"
dropdb -U claude -h localhost --if-exists medusapos_g4
createdb -U claude -h localhost medusapos_g4
cd "$script_dir/../../../apps/backend"
npx medusa db:migrate --skip-scripts
npx medusa db:migrate:search
npx medusa exec ./src/scripts/seed-e2e.ts
npx medusa user -e g4@tally.test -p g4-probe-password

export G4_EVENT_BUS="$bus"
if [ "$bus" = redis ]; then
  export G4_REDIS_URL="redis://127.0.0.1:6379/5"
fi
export G4_EVENT_PROBE_FILE="$out_dir/events.jsonl"
: > "$G4_EVENT_PROBE_FILE"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill -- "-$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Bash job control gives medusa develop and its child server their own group.
set -m
npx medusa develop --port 9200 > "$out_dir/server.log" 2>&1 &
server_pid=$!
deadline=$((SECONDS + 240))
until curl -fsS --max-time 1 http://127.0.0.1:9200/health >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Store did not come up; see $out_dir/server.log" >&2
    exit 1
  fi
  sleep 1
done
node "$script_dir/driver.mjs" http://127.0.0.1:9200 "$out_dir/events.jsonl" "$out_dir/results.json"
