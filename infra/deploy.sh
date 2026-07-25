#!/usr/bin/env bash
# deploy.sh — blue-green deploy for url-shortener on a single EC2 instance.
# Run from any directory: bash ~/url-shortener/infra/deploy.sh
set -euo pipefail

# ── STEP 0: Bootstrap ────────────────────────────────────────────────────────

DEPLOY_ENV="$HOME/deploy.env"
if [[ ! -f "$DEPLOY_ENV" ]]; then
  echo "ERROR: $DEPLOY_ENV not found."
  echo "  Copy it from the repo and fill in values:"
  echo "  scp infra/deploy.env.example ec2-user@<host>:~/deploy.env"
  exit 1
fi
# shellcheck source=/dev/null
source "$DEPLOY_ENV"

# Derived paths
NEW_DIR="${APP_DIR}-new"
OLD_DIR="${APP_DIR}-old"
FAILED_DIR="${APP_DIR}-failed"
INFRA_DIR="$(dirname "$APP_DIR")/infra"

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}"
VALKEY_URL="redis://:${VALKEY_PASSWORD}@localhost:6379"

# ── STEP 1: Validate required variables ──────────────────────────────────────

REQUIRED_VARS=(
  REPO_URL APP_DIR DEPLOY_BRANCH
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  VALKEY_PASSWORD
  JWT_SECRET JWT_REFRESH_SECRET IP_HASH_SECRET
  BASE_URL REDIRECT_URL CLIENT_ORIGINS
)
missing=0
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: ${var} is required but not set in deploy.env"
    missing=1
  fi
done
[[ "$missing" -eq 1 ]] && exit 1
echo "✓ All required variables present"

# ── STEP 1.5: Memory threshold check ─────────────────────────────────────────
# If the server's RAM usage is at/above MEMORY_RELOAD_THRESHOLD_PERCENT,
# reload PM2 processes before continuing so the deploy doesn't push an
# already-pressured box into OOM. Docker containers (Postgres/Valkey) are
# NOT touched here — they hold persistent state and should be managed
# separately (see README "Memory management").

_check_memory() {
  local threshold="${MEMORY_RELOAD_THRESHOLD_PERCENT:-85}"
  local mem_total mem_available mem_used_pct

  mem_total=$(awk '/MemTotal/      {print $2}' /proc/meminfo)
  mem_available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)

  if [[ -z "$mem_total" || -z "$mem_available" || "$mem_total" -eq 0 ]]; then
    echo "  ⚠ Could not read /proc/meminfo — skipping memory check."
    return 0
  fi

  mem_used_pct=$(( (mem_total - mem_available) * 100 / mem_total ))
  echo "  Memory: ${mem_used_pct}% used (threshold: ${threshold}%)"

  if [[ "$mem_used_pct" -ge "$threshold" ]]; then
    echo "→ Memory at/above threshold — reloading PM2 processes to release RAM..."
    # reload = zero-downtime graceful reload; fall back to restart if needed.
    pm2 reload all || pm2 restart all || true
    sleep 2
    mem_available=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
    mem_used_pct=$(( (mem_total - mem_available) * 100 / mem_total ))
    echo "  After reload: ${mem_used_pct}% used"

    if [[ "$mem_used_pct" -ge "$threshold" ]]; then
      echo "  ⚠ Memory still above threshold after reload."
      echo "    Consider restarting Docker containers manually:"
      echo "      docker compose --project-directory ${INFRA_DIR} restart"
      echo "    or upgrading the EC2 instance size before deploying."
    fi
  fi
}
_check_memory

# ── STEP 2: Pre-flight cleanup ────────────────────────────────────────────────

for dir in "$NEW_DIR" "$FAILED_DIR" "$OLD_DIR"; do
  if [[ -d "$dir" ]]; then
    rm -rf "$dir"
    echo "  Cleaned up: $dir"
  fi
done

# ── STEP 3: Fresh clone ───────────────────────────────────────────────────────

echo "→ Cloning ${REPO_URL} (branch: ${DEPLOY_BRANCH}) into ${NEW_DIR}..."
if ! git clone --branch "$DEPLOY_BRANCH" "$REPO_URL" "$NEW_DIR"; then
  echo "ERROR: git clone failed. Check SSH key, REPO_URL, and branch name."
  exit 1
fi
COMMIT=$(git -C "$NEW_DIR" rev-parse --short HEAD)
echo "✓ Cloned at commit ${COMMIT}"

# ── STEP 4: Write .env files ──────────────────────────────────────────────────

# Root .env (for docker-compose reference consistency)
cat > "$NEW_DIR/.env" <<EOF
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
VALKEY_PASSWORD=${VALKEY_PASSWORD}
EOF

cat > "$NEW_DIR/server/api/.env" <<EOF
NODE_ENV=production
PORT=3000
API_HOST=127.0.0.1
DATABASE_URL=${DATABASE_URL}
VALKEY_URL=${VALKEY_URL}
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
BASE_URL=${BASE_URL}
REDIRECT_URL=${REDIRECT_URL}
CLIENT_ORIGINS=${CLIENT_ORIGINS}
DEFAULT_URL_TTL_DAYS=${DEFAULT_URL_TTL_DAYS:-7}
RATE_LIMIT_CREATE_LIMIT=${RATE_LIMIT_CREATE_LIMIT:-100}
RATE_LIMIT_WINDOW_SECS=${RATE_LIMIT_WINDOW_SECS:-3600}
RATE_LIMIT_LOGIN_LIMIT=${RATE_LIMIT_LOGIN_LIMIT:-5}
RATE_LIMIT_LOGIN_WINDOW_SECS=${RATE_LIMIT_LOGIN_WINDOW_SECS:-60}
RATE_LIMIT_LOGIN_ACCOUNT_LIMIT=${RATE_LIMIT_LOGIN_ACCOUNT_LIMIT:-10}
RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECS=${RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECS:-900}
RATE_LIMIT_REGISTER_LIMIT=${RATE_LIMIT_REGISTER_LIMIT:-5}
RATE_LIMIT_REGISTER_WINDOW_SECS=${RATE_LIMIT_REGISTER_WINDOW_SECS:-60}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-30000}
EOF

cat > "$NEW_DIR/server/redirect/.env" <<EOF
NODE_ENV=production
PORT=3001
REDIRECT_HOST=127.0.0.1
DATABASE_URL=${DATABASE_URL}
VALKEY_URL=${VALKEY_URL}
RATE_LIMIT_REDIRECT_LIMIT=${RATE_LIMIT_REDIRECT_LIMIT:-100}
RATE_LIMIT_WINDOW_SECS=${RATE_LIMIT_REDIRECT_WINDOW_SECS:-60}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-30000}
EOF

cat > "$NEW_DIR/server/worker/.env" <<EOF
NODE_ENV=production
DATABASE_URL=${DATABASE_URL}
VALKEY_URL=${VALKEY_URL}
IP_HASH_SECRET=${IP_HASH_SECRET}
GEO_ENABLED=${GEO_ENABLED:-true}
GEO_TIMEOUT_MS=${GEO_TIMEOUT_MS:-2000}
CLICK_BATCH_SIZE=${CLICK_BATCH_SIZE:-100}
CLICK_FLUSH_MS=${CLICK_FLUSH_MS:-5000}
WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-10}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-30000}
EOF

# Client env — reference only; actual build happens on Vercel
cat > "$NEW_DIR/client/.env.production.local" <<EOF
# This file is for local reference only.
# Set NEXT_PUBLIC_API_BASE_URL in your Vercel project environment variables.
NEXT_PUBLIC_API_BASE_URL=${BASE_URL}
EOF

echo "✓ .env files written"

# ── STEP 5: Write infra/.env ──────────────────────────────────────────────────

mkdir -p "$INFRA_DIR"
cat > "$INFRA_DIR/.env" <<EOF
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
VALKEY_PASSWORD=${VALKEY_PASSWORD}
EOF
echo "✓ infra/.env written"

# ── STEP 6: Docker — ensure infra containers are running ─────────────────────

echo "→ Starting Docker containers..."
docker compose --project-directory "$INFRA_DIR" --env-file "$INFRA_DIR/.env" pull --quiet
docker compose --project-directory "$INFRA_DIR" --env-file "$INFRA_DIR/.env" up -d
echo "✓ Docker containers running"

# ── STEP 7: Install dependencies ─────────────────────────────────────────────

echo "→ Installing server dependencies..."
(cd "$NEW_DIR/server" && npm ci)
echo "✓ Server dependencies installed"
echo "ℹ Client dependencies skipped (Vercel)"

# ── STEP 8: Generate Prisma clients (required before TypeScript build) ────────
# api, redirect, and worker all import from the generated client
# (src/generated/prisma/). tsc cannot find the module until this runs.

echo "→ Generating Prisma clients..."
(cd "$NEW_DIR/server/api"      && npx prisma generate)
(cd "$NEW_DIR/server/redirect" && npx prisma generate)
(cd "$NEW_DIR/server/worker"   && npx prisma generate)
echo "✓ Prisma clients generated"

# ── STEP 9: Build ─────────────────────────────────────────────────────────────

echo "→ Building services..."
if ! (cd "$NEW_DIR/server" && npm run build:shared && npm run build:api && npm run build:redirect && npm run build:worker); then
  rm -rf "$NEW_DIR"
  echo "ERROR: Build failed. Cleaned up ${NEW_DIR}."
  exit 1
fi
echo "✓ All services built"
echo "ℹ Client build skipped (Vercel)"

# ── STEP 10: Run migrations ───────────────────────────────────────────────────

echo "→ Running migrations..."
if ! (cd "$NEW_DIR/server/api" && DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy); then
  rm -rf "$NEW_DIR"
  echo "ERROR: Migration failed. DB state unknown — do NOT proceed. Cleaned up ${NEW_DIR}."
  exit 1
fi
echo "✓ Migrations applied"

# ── STEP 11: Generate ecosystem.config.cjs ────────────────────────────────────

mkdir -p "$APP_DIR/logs" 2>/dev/null || true
mkdir -p "$NEW_DIR/logs"

sed "s|APP_DIR_PLACEHOLDER|${APP_DIR}|g" \
  "$(dirname "$0")/ecosystem.config.cjs" \
  > "$NEW_DIR/ecosystem.config.cjs"
echo "✓ ecosystem.config.cjs written"

# ── STEP 12: Nginx config test ────────────────────────────────────────────────

if ! sudo nginx -t; then
  echo "ERROR: Nginx config invalid — aborting. Live server is still running."
  exit 1
fi
echo "✓ Nginx config valid"

# ── STEP 13: Stop PM2 ─────────────────────────────────────────────────────────

pm2 stop all || true
echo "✓ PM2 processes stopped"

# ── STEP 14: Blue-green swap ──────────────────────────────────────────────────

mv "$APP_DIR" "$OLD_DIR"
mv "$NEW_DIR" "$APP_DIR"
echo "✓ Swap complete: url-shortener-new → url-shortener, url-shortener → url-shortener-old"

# ── STEP 15: Start PM2 on new code ───────────────────────────────────────────

cd "$APP_DIR"
pm2 start ecosystem.config.cjs
pm2 save
echo "✓ PM2 started on new code"

# ── Health check helper ───────────────────────────────────────────────────────

_health_check() {
  local retries="${HEALTH_CHECK_RETRIES:-5}"
  local interval="${HEALTH_CHECK_INTERVAL_SECS:-3}"
  for i in $(seq 1 "$retries"); do
    echo "  Health check attempt ${i}/${retries}..."
    if curl -sf "${BASE_URL}/health" > /dev/null; then
      return 0
    fi
    sleep "$interval"
  done
  return 1
}

# ── STEP 16: Health check ─────────────────────────────────────────────────────

if _health_check; then
  # ── STEP 17: Post-deploy cleanup and nginx reload ─────────────────────────
  sudo systemctl reload nginx
  echo "✓ Nginx reloaded"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "✓ Deploy complete"
  echo "  Commit : ${COMMIT}"
  echo "  Time   : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "  Backup : ${OLD_DIR} (kept for manual rollback)"
  echo "  Manual rollback: bash ~/url-shortener/infra/rollback.sh"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  pm2 list
  exit 0
fi

# ── STEP 18: Auto-rollback ────────────────────────────────────────────────────

echo "✗ Health check failed — initiating auto-rollback..."
pm2 stop all || true
mv "$APP_DIR" "$FAILED_DIR"
mv "$OLD_DIR" "$APP_DIR"
cd "$APP_DIR"
pm2 start ecosystem.config.cjs
pm2 save

if _health_check; then
  echo "✓ Rollback successful — old version is live again."
  echo "  Inspect failed deploy at: ${FAILED_DIR}"
  rm -rf "$FAILED_DIR"
  exit 1
else
  echo "CRITICAL: Rollback health check also failed."
  echo "  Failed deploy : ${FAILED_DIR}"
  echo "  Restored dir  : ${APP_DIR}"
  echo "  Manual intervention required."
  exit 1
fi
