#!/usr/bin/env bash
# Run database migrations and start the demo backend production server.
# Coolify runs this script as the container command.
set -euo pipefail

cd /src/app/dev/medusa-store/apps/backend/.medusa/server
/src/app/dev/medusa-store/node_modules/.bin/medusa db:migrate
/src/app/dev/medusa-store/node_modules/.bin/medusa db:migrate:search
exec /src/app/dev/medusa-store/node_modules/.bin/medusa start --host 0.0.0.0 --port 9000
