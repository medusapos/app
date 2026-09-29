#!/usr/bin/env bash
# rxdb-premium's postinstall prints `accessToken: <token>`; filter it out of every hosted install log.
set -euo pipefail

set +e
pnpm install "$@" 2>&1 | grep -vi 'accesstoken'
pnpm_status=${PIPESTATUS[0]}
set -e
exit "$pnpm_status"
