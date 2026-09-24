#!/usr/bin/env bash
# ADR-060 evidence: Medusa 2.21's GET /admin/products honours the
# updated_at[$gte] query form but silently ignores the plain updated_at[gte]
# form (TallyUI's replication pull queries it that way). Read-only.
# Only ever point this at the disposable e2e store (bash e2e/store/start.sh
# from the repo root). Never run it against a shared or production store.
set -euo pipefail
base="${PROBE_BASE_URL:-http://127.0.0.1:9100}"
email="${PROBE_EMAIL:-e2e@tally.test}"
password="${PROBE_PASSWORD:-e2e-password}"

token=$(curl -fsS -X POST "$base/auth/user/emailpass" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$email" --arg password "$password" '{email: $email, password: $password}')" \
  | jq -r .token)
future=2099-01-01T00:00:00.000Z
# shellcheck disable=SC2016 # 'updated_at[$gte]' is a literal query key, not an expansion
for key in 'updated_at[gte]' 'updated_at[$gte]'; do
  printf '%-18s = %s -> ' "$key" "$future"
  curl -sS -G -H "Authorization: Bearer $token" "$base/admin/products" \
    --data-urlencode "$key=$future" --data-urlencode "fields=id" -w ' HTTP %{http_code}' -o /dev/stderr 2>&1 \
    | tr '\n' ' ' | sed -E 's/"products":\[[^]]*\]/"products":[...]/'
  echo
done
