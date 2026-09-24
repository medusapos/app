#!/usr/bin/env bash
# Medusa price sync evidence: does editing only a variant's price through the
# admin API bump the variant's updated_at, its price's updated_at, or the
# product's? An incremental variant feed filtered on updated_at only sees a
# price edit if the variant's updated_at moves.
# Two edits, one per route: first the batch route the admin dashboard's price
# editor uses (POST /admin/products/:id/variants/batch), then the single
# variant update (POST /admin/products/:id/variants/:variant_id). Each sends
# only a prices array for one currency.
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
  title: "Price edit probe", handle: "price-edit-probe", status: "published", shipping_profile_id: $profile,
  options: [{ title: "Size", values: ["A"] }],
  variants: [{ title: "A", sku: "PROBE-PRICE", options: { Size: "A" }, prices: [{ currency_code: "eur", amount: 1 }] }]
}')
product=$(curl -fsS "${auth[@]}" -X POST "$base/admin/products" -d "$body" | jq -r .product.id)
variant=$(curl -fsS "${auth[@]}" "$base/admin/products/$product?fields=variants.id" | jq -r '.product.variants[0].id')
price=$(curl -fsS "${auth[@]}" "$base/admin/products/$product?fields=variants.prices.id" | jq -r '.product.variants[0].prices[0].id')
echo "created product $product, variant $variant, eur price $price"

show() {
  echo "--- $1"
  curl -fsS -G "${auth[@]}" "$base/admin/product-variants" --data-urlencode 'limit=1' \
    --data-urlencode "id[]=$variant" --data-urlencode 'fields=id,updated_at,prices.id,prices.amount,prices.currency_code,prices.updated_at' \
    | jq -c '.variants[0] | {variant: .id, variant_updated_at: .updated_at, prices: [.prices[] | {id, currency_code, amount, updated_at}]}'
  curl -fsS "${auth[@]}" "$base/admin/products/$product?fields=id,updated_at" \
    | jq -c '{product: .product.id, product_updated_at: .product.updated_at}'
}

show "before"
sleep 2
echo "--- POST /admin/products/$product/variants/batch (update: eur 1 -> 2) at $(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
curl -fsS "${auth[@]}" -X POST "$base/admin/products/$product/variants/batch" \
  -d "$(jq -n --arg variant "$variant" --arg price "$price" \
    '{update: [{id: $variant, prices: [{id: $price, currency_code: "eur", amount: 2}]}]}')" \
  | jq -c '{updated: [.updated[]? | .id]}'
show "after batch route"
sleep 2
echo "--- POST /admin/products/$product/variants/$variant (eur 2 -> 3) at $(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
curl -fsS "${auth[@]}" -X POST "$base/admin/products/$product/variants/$variant" \
  -d "$(jq -n --arg price "$price" '{prices: [{id: $price, currency_code: "eur", amount: 3}]}')" \
  | jq -c '{product: .product.id}'
show "after variant update route"

curl -fsS "${auth[@]}" -X DELETE "$base/admin/products/$product" | jq -c '{id, object, deleted}'
echo "cleaned up"
