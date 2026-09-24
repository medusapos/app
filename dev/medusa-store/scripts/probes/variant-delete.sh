#!/usr/bin/env bash
# ADR-060 evidence: deleting a variant in Medusa 2.21 does not bump the
# product's updated_at. A pull correctly filtered on updated_at
# (updated_at[$gte]) would therefore miss the change. TallyUI's current
# replication pull instead sends the plain updated_at[gte] form, which
# Medusa silently ignores (see updated-at-filter.sh), so today it re-reads
# everything and picks the change up by accident.
# Creates and deletes a throwaway product — only ever point this at the
# disposable e2e store (bash e2e/store/start.sh from the repo root). Never
# run it against a shared or production store.
set -euo pipefail
base="${PROBE_BASE_URL:-http://127.0.0.1:9100}"
email="${PROBE_EMAIL:-e2e@tally.test}"
password="${PROBE_PASSWORD:-e2e-password}"

token=$(curl -fsS -X POST "$base/auth/user/emailpass" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$email" --arg password "$password" '{email: $email, password: $password}')" \
  | jq -r .token)
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')
profile=$(curl -fsS "${auth[@]}" "$base/admin/shipping-profiles?limit=1" | jq -r '.shipping_profiles[0].id')

body=$(jq -n --arg profile "$profile" '{
  title: "ADR-060 probe", handle: "adr-060-probe", status: "published", shipping_profile_id: $profile,
  options: [{ title: "Size", values: ["A", "B"] }],
  variants: [
    { title: "A", sku: "PROBE-A", options: { Size: "A" }, prices: [{ currency_code: "eur", amount: 1 }] },
    { title: "B", sku: "PROBE-B", options: { Size: "B" }, prices: [{ currency_code: "eur", amount: 1 }] }
  ] }')
product=$(curl -fsS "${auth[@]}" -X POST "$base/admin/products" -d "$body" | jq -r .product.id)
echo "created product $product"

show() {
  echo "--- $1"
  curl -fsS "${auth[@]}" "$base/admin/products/$product?fields=id,updated_at,variants.id,variants.sku" \
    | jq -c '{product: .product.id, updated_at: .product.updated_at, variants: [.product.variants[].sku]}'
}
listing() {
  echo "--- listing with updated_at[gte]=$1 (as TallyUI's pull queries)"
  curl -fsS -G "${auth[@]}" "$base/admin/products" --data-urlencode "updated_at[gte]=$1" \
    --data-urlencode "fields=id,updated_at,variants.sku" --data-urlencode "order=id" \
    | jq -c '{count: .count, products: [.products[] | {id, updated_at, variants: [.variants[].sku]}]}'
}

show "before delete"
before=$(curl -fsS "${auth[@]}" "$base/admin/products/$product?fields=updated_at" | jq -r .product.updated_at)
variant_b=$(curl -fsS "${auth[@]}" "$base/admin/products/$product?fields=variants.id,variants.sku" \
  | jq -r '.product.variants[] | select(.sku=="PROBE-B") | .id')
sleep 2
mark=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
sleep 1
echo "--- DELETE /admin/products/$product/variants/$variant_b at $mark"
curl -fsS "${auth[@]}" -X DELETE "$base/admin/products/$product/variants/$variant_b" | jq -c '{id, object, deleted}'
show "after delete"
after=$(curl -fsS "${auth[@]}" "$base/admin/products/$product?fields=updated_at" | jq -r .product.updated_at)
echo "updated_at before: $before"
echo "updated_at after:  $after"
listing "$mark"

curl -fsS "${auth[@]}" -X DELETE "$base/admin/products/$product" | jq -c '{id, object, deleted}'
echo "cleaned up"
