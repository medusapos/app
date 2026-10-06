#!/usr/bin/env bash
# Local only: replaces and removes medusapos_showcase_check on localhost as claude.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
export PGUSER=claude PGHOST=localhost PGPORT=5432 PGDATABASE=medusapos_showcase_check
export PGPASSWORD="${DB_PASSWORD:-}"
export DATABASE_URL="$(node -e 'const u = new URL("postgres://claude@localhost:5432/medusapos_showcase_check"); u.password = process.env.PGPASSWORD; process.stdout.write(u.href)')"
export npm_config_cache="$PWD/e2e/.tmp/npm-cache"
export npm_config_offline=true npm_config_update_notifier=false
export XDG_CONFIG_HOME="$PWD/e2e/.tmp/xdg" MEDUSA_DISABLE_TELEMETRY=true
export JWT_SECRET=e2e-jwt-secret COOKIE_SECRET=e2e-cookie-secret
export STORE_CORS=http://localhost:8099 ADMIN_CORS=http://localhost:8099 AUTH_CORS=http://localhost:8099
unset TALLY_E2E_PLUGIN
dropdb --if-exists medusapos_showcase_check
createdb medusapos_showcase_check
cd dev/medusa-store/apps/backend
npx medusa db:migrate
npx medusa db:migrate:search
for seed in seed-tax-rates seed-e2e seed-demo-showcase seed-demo-presentation; do
  npx medusa exec "./src/scripts/$seed.ts"
done
npx medusa user -e cashier@demo.medusapos.com -p demo1234
npx medusa user -e manager@demo.medusapos.com -p demo1234
# Compare data (including timestamps) to catch updates as well as duplicate inserts.
snapshot_sql=$(cat <<'SQL'
SELECT md5(string_agg(row, E'\n' ORDER BY row)) FROM (
  SELECT row_to_json(p)::text AS row FROM product p UNION ALL SELECT row_to_json(v)::text FROM product_variant v
  UNION ALL SELECT row_to_json(c)::text FROM product_category c UNION ALL SELECT row_to_json(i)::text FROM inventory_level i
  UNION ALL SELECT row_to_json(c)::text FROM customer c UNION ALL SELECT row_to_json(o)::text FROM "order" o
  UNION ALL SELECT row_to_json(p)::text FROM price p) data
SQL
)
before=$(psql -XAt -v ON_ERROR_STOP=1 -c "$snapshot_sql")
npx medusa exec ./src/scripts/seed-demo-showcase.ts
after=$(psql -XAt -v ON_ERROR_STOP=1 -c "$snapshot_sql")
[[ "$before" == "$after" ]]
echo 'Idempotency: unchanged'
psql -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) AS published_products FROM product WHERE status = 'published' AND deleted_at IS NULL;
SELECT count(*) AS showcase_products FROM product WHERE handle LIKE 'showcase-%' AND deleted_at IS NULL;
SELECT count(*) AS customers FROM customer WHERE deleted_at IS NULL;
SELECT count(*) AS showcase_orders FROM "order" WHERE metadata->>'showcase_order' IS NOT NULL AND deleted_at IS NULL;
SELECT count(*) AS demo_users FROM "user" WHERE email IN ('cashier@demo.medusapos.com', 'manager@demo.medusapos.com') AND deleted_at IS NULL;
SQL
dropdb medusapos_showcase_check
