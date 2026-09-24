#!/usr/bin/env bash
# Prove production health on Postgres 16 without Redis, the in-memory fallback
# log, and golden-copy reset followed by a healthy restart after PID 1 stops.
# The Demo backend image workflow runs this before pushing.
set -euo pipefail

image="${1:?usage: smoke.sh <image>}"
trap 'if (( $? != 0 )); then docker logs --tail 200 mpdemo-smoke-backend 2>&1 || true; fi' EXIT

docker network create mpdemo-smoke
docker run -d --name mpdemo-smoke-pg --network mpdemo-smoke \
  -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=medusapos_demo postgres:16-alpine
deadline=$((SECONDS + 60))
until docker exec mpdemo-smoke-pg pg_isready -h 127.0.0.1 -U postgres -d medusapos_demo; do
  if (( SECONDS >= deadline )); then
    echo 'smoke: Postgres readiness timed out after 60 seconds' >&2
    exit 1
  fi
  sleep 1
done

docker run -d --name mpdemo-smoke-backend --network mpdemo-smoke \
  --restart unless-stopped -p 9000:9000 \
  -e 'DATABASE_URL=postgres://postgres:smoke@mpdemo-smoke-pg:5432/medusapos_demo?sslmode=disable' \
  -e JWT_SECRET=smoke-jwt -e COOKIE_SECRET=smoke-cookie \
  -e STORE_CORS=http://localhost:8081 -e ADMIN_CORS=http://localhost:8081 \
  -e AUTH_CORS=http://localhost:8081 "$image"

wait_healthy() {
  local deadline=$((SECONDS + 600))
  until curl -fsS http://127.0.0.1:9000/health; do
    if (( SECONDS >= deadline )); then
      echo 'smoke: backend health timed out after 600 seconds' >&2
      return 1
    fi
    sleep 5
  done
}
wait_healthy

backend_logs=$(docker logs mpdemo-smoke-backend 2>&1)
if [[ "$backend_logs" != *'redisUrl not found'* ]]; then
  echo 'smoke: in-memory Redis fallback log not found' >&2
  exit 1
fi

docker stop mpdemo-smoke-backend
docker exec mpdemo-smoke-pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE medusapos_demo_golden TEMPLATE medusapos_demo'
docker start mpdemo-smoke-backend
wait_healthy

restart_count=$(docker inspect -f '{{.RestartCount}}' mpdemo-smoke-backend)
reset_output=$(docker exec mpdemo-smoke-backend /src/app/deploy/demo-backend/reset.sh 2>&1) || true
printf '%s\n' "$reset_output"
if [[ "$reset_output" != *'medusapos_demo recreated from medusapos_demo_golden'* ]]; then
  echo 'smoke: reset did not report recreating the database from the golden copy' >&2
  exit 1
fi

deadline=$((SECONDS + 60))
while (( $(docker inspect -f '{{.RestartCount}}' mpdemo-smoke-backend) <= restart_count )); do
  if (( SECONDS >= deadline )); then
    echo 'smoke: backend restart timed out after 60 seconds' >&2
    exit 1
  fi
  sleep 1
done
wait_healthy

echo 'smoke: ok'
