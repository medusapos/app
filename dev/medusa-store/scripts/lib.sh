# Shared settings for the dev-store scripts. Sourced, not run.
# The store runs from a deployed copy, not from a git checkout, so deleting a
# worktree never takes the store down.
MEDUSA_DEV_HOME="${MEDUSA_DEV_HOME:-$HOME/Projects/medusa-dev}"
DB_NAME="tallyui_medusa_dev"
PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
PID_FILE="$MEDUSA_DEV_HOME/logs/medusa.pid"
LOG_FILE="$MEDUSA_DEV_HOME/logs/medusa.log"
ADMIN_EMAIL="admin@tally.test"
# Dev-only credentials for a store bound to 127.0.0.1.
ADMIN_PASSWORD="tally-dev-admin"
export PATH="/opt/homebrew/bin:$PG_BIN:$PATH"

stop_store() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    # medusa develop spawns a child server; stop the whole process group.
    kill -- "-$(cat "$PID_FILE")" 2>/dev/null || kill "$(cat "$PID_FILE")"
    sleep 2
  fi
  rm -f "$PID_FILE"
}

wait_for_store() {
  for _ in $(seq 1 120); do
    curl -fsS http://127.0.0.1:9000/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "Store did not come up; see $LOG_FILE" >&2
  return 1
}
