#!/usr/bin/env bash
# Reproduce Render's backend build lifecycle locally.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"

: "${DATABASE_URL:?Set DATABASE_URL to a local or test Postgres URL}"
: "${VALKEY_URL:?Set VALKEY_URL to a local or test Valkey URL}"
: "${JWT_SECRET:?Set JWT_SECRET for the API build/runtime check}"
: "${JWT_REFRESH_SECRET:?Set JWT_REFRESH_SECRET for the API build/runtime check}"
: "${IP_HASH_SECRET:?Set IP_HASH_SECRET for the worker runtime check}"

cd "$SERVER_DIR"
npm ci --include=dev
npm run build:shared
(cd api && npx prisma generate && npx prisma migrate deploy)
(cd redirect && npx prisma generate)
(cd worker && npx prisma generate)
npm run build:api
npm run build:redirect
npm run build:worker
npm run --prefix worker test:unit

printf '\nRender backend build and unit validation passed.\n'
