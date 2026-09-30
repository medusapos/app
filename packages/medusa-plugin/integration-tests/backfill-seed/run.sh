#!/usr/bin/env bash
# Seeds a fresh local database with the rejected-order scenarios and runs tally-ledger-backfill-rejected five times,
# as an operator types it (see README.md). Local only: any host but localhost, or any other database name, is refused.
set -euo pipefail
plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
host="${DB_HOST:-localhost}" port="${DB_PORT:-5432}" user="${DB_USERNAME:-postgres}" name="${DB_NAME:-medusapos_backfill_seed}"
fail() { echo "run.sh: $*" >&2; exit 1; }
[[ "$host" == localhost || "$host" == 127.0.0.1 ]] || fail "refusing database host '$host': only localhost or 127.0.0.1"
# Letters, digits and _ only, so nothing in the URL can name another host.
[[ "$name" =~ ^medusapos_backfill_seed[A-Za-z0-9_]*$ ]] || fail "refusing database '$name': the name must start with medusapos_backfill_seed"
[[ "$user" =~ ^[A-Za-z0-9_]+$ && "$port" =~ ^[0-9]+$ ]] || fail 'DB_USERNAME must be letters, digits or _, and DB_PORT digits'
# Nothing else may redirect a connection: libpq's host overrides, and the Redis modules defineConfig adds for these.
unset PGHOSTADDR PGSERVICE PGSERVICEFILE REDIS_URL CACHE_REDIS_URL EXECUTION_CONTEXT
if [[ -n "${DB_PASSWORD:-}" ]]; then export PGPASSWORD="$DB_PASSWORD"; fi
export DATABASE_URL="postgres://$user@$host:$port/$name"
logs="/tmp/medusapos-backfill-seed-$$"
mkdir -p "$logs"
log="$logs/run.log"
trap 'echo "run.sh: failed at line $LINENO; see $log" >&2' ERR

createdb -h "$host" -p "$port" -U "$user" "$name" >>"$log" 2>&1
# Only a database this run created is dropped, even when a later step fails.
drop() { if [[ "${KEEP_DB:-}" == 1 ]]; then echo "run.sh: kept database $name" >&2; else dropdb -h "$host" -p "$port" -U "$user" "$name" >>"$log" 2>&1; fi; }
trap drop EXIT
(cd "$plugin" && npm run build) >>"$log" 2>&1
# The medusa CLI runs only where a package.json names @medusajs/medusa, which plugin-app has not, so a throwaway
# project under $logs loads plugin-app's medusa-config.ts unchanged, with the plugin's node_modules and tsconfig.
app="$logs/app"
mkdir "$app"
ln -s "$plugin/node_modules" "$app/node_modules"
ln -s "$plugin" "$app/medusa-plugin"
printf '{ "private": true, "devDependencies": { "@medusajs/medusa": "2.21.0" } }\n' >"$app/package.json"
printf "module.exports = require('./medusa-plugin/integration-tests/plugin-app/medusa-config.ts')\n" >"$app/medusa-config.js"
export TS_NODE_PROJECT="$plugin/tsconfig.json"
cd "$app"
npx medusa db:migrate >>"$log" 2>&1
npx medusa exec medusa-plugin/integration-tests/backfill-seed/seed.ts >>"$log" 2>&1

# The backfill's own lines, without colours or the logger's level and timestamp prefix.
own() { sed -E $'s/\x1b\\[[0-9;]*m//g' | grep 'tally_ledger_backfill_rejected' | sed -E 's/^.*(tally_ledger_backfill_rejected)/\1/'; }
# The order and session lines a run reports (not its summary or warnings).
figures() { grep -E '^tally_ledger_backfill_rejected: (command .*, order |session |no session: )' <<<"$1" || true; }
script=medusa-plugin/.medusa/server/src/scripts/tally-ledger-backfill-rejected.js
runs=()
n=0
# The medusa CLI refuses an unknown option such as --apply ("Unknown argument: apply"), so it goes after --.
for args in '' --apply '' --undo ''; do
  n=$((n + 1))
  echo "=== $n. npx medusa exec $script${args:+ -- $args}"
  out="$(npx medusa exec "$script" ${args:+-- "$args"} 2>&1)" || { printf '%s\n' "$out" >>"$log"; fail "run $n failed; see $log"; }
  printf '=== %s\n%s\n' "$n" "$out" >>"$log"
  runs+=("$(own <<<"$out")")
  printf '%s\n' "${runs[n - 1]}"
done

grep -q '(dry run): would mark 0 order(s)' <<<"${runs[2]}" || fail 'assertion failed: the second dry run (run 3) does not say would mark 0'
[[ -n "$(figures "${runs[0]}")" ]] || fail 'assertion failed: the first dry run (run 1) reports no order or session lines'
[[ "$(figures "${runs[4]}")" == "$(figures "${runs[0]}")" ]] ||
  fail 'assertion failed: the third dry run (run 5) order and session lines differ from the first (run 1)'
echo "run.sh: assertions passed; logs in $log" >&2
