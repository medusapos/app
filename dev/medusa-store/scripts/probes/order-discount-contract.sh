#!/usr/bin/env bash
# order.create version 2 live contract (TallyUI ADR-062): the plugin's integration case 2 against a
# real Medusa 2.21.0. The e2e store sells from Copenhagen, so the tax is 25%, 10% off each line:
#   E2E-1 inclusive 1000 − 100 = 900 gross (net 720, tax 180); E2E-2 exclusive 1000 − 100 = 900 net,
#   tax 225, 1125. Subtotal 1620, tax 405, total 2025. Expect `applied`, no warnings, total 20.25,
#   and one "POS discount" adjustment of 1 per item, is_tax_inclusive matching the item.
# Creates a real order — only ever point this at the disposable e2e store (bash e2e/store/start.sh).
set -euo pipefail
base="${PROBE_BASE_URL:-http://127.0.0.1:9100}"
email="${PROBE_EMAIL:-e2e@tally.test}"
password="${PROBE_PASSWORD:-e2e-password}"

token=$(curl -fsS -X POST "$base/auth/user/emailpass" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$email" --arg password "$password" '{email: $email, password: $password}')" | jq -r .token)
auth=(-H "Authorization: Bearer $token")
echo "--- GET /tally/v1/info: $(curl -sS "${auth[@]}" "$base/tally/v1/info")"
variants=$(curl -fsS "${auth[@]}" "$base/admin/product-variants?limit=100&fields=id,sku")
a=$(jq -r '.variants[] | select(.sku == "E2E-1") | .id' <<<"$variants")
b=$(jq -r '.variants[] | select(.sku == "E2E-2") | .id' <<<"$variants")
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
body=$(jq -n --arg a "$a" --arg b "$b" --arg now "$now" --arg id "probe-$(date +%s)" '{commands: [{
  id: $id, type: "order.create", version: 2, createdAt: $now, deviceId: "probe", attempt: 1,
  payload: { clientOrderId: $id, createdAt: $now, currency: "EUR", pricesIncludeTax: true, discountMinor: 200,
    lines: [{ clientLineId: "a", variantId: $a, quantity: 1, unitPriceMinor: 1000, discountMinor: 100 },
      { clientLineId: "b", variantId: $b, quantity: 1, unitPriceMinor: 1000, taxInclusive: false, discountMinor: 100 }],
    subtotalMinor: 1620, taxMinor: 405, totalMinor: 2025,
    payments: [{ clientPaymentId: "cash", method: "cash", amountMinor: 2025 }] } }]}')
result=$(curl -fsS "${auth[@]}" -H 'Content-Type: application/json' -H 'X-Tally-Protocol: 1' -X POST "$base/tally/v1/commands" -d "$body")
echo "--- POST /tally/v1/commands: $(jq -c '.results[0] | {status, warnings, serverRefs, error}' <<<"$result")"
order=$(jq -r '.results[0].serverRefs.orderId' <<<"$result")
echo "--- GET /admin/orders/$order"
curl -fsS "${auth[@]}" "$base/admin/orders/$order?fields=total,tax_total,items.adjustments.*,items.is_tax_inclusive" | jq .
