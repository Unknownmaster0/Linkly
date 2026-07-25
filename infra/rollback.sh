#!/usr/bin/env bash
# rollback.sh — manually roll back to the previous deploy.
# Run from any directory: bash ~/url-shortener/infra/rollback.sh
set -euo pipefail

DEPLOY_ENV="$HOME/deploy.env"
if [[ ! -f "$DEPLOY_ENV" ]]; then
  echo "ERROR: $DEPLOY_ENV not found."
  exit 1
fi
# shellcheck source=/dev/null
source "$DEPLOY_ENV"

OLD_DIR="${APP_DIR}-old"
FAILED_DIR="${APP_DIR}-failed"

# ── STEP 0: Check backup exists ───────────────────────────────────────────────

if [[ ! -d "$OLD_DIR" ]]; then
  echo "ERROR: No backup available at ${OLD_DIR}. Cannot roll back."
  exit 1
fi

echo "→ Rolling back to ${OLD_DIR}..."

# ── STEP 2: Stop PM2 ──────────────────────────────────────────────────────────

pm2 stop all || true
echo "✓ PM2 processes stopped"

# ── STEP 3-4: Swap ────────────────────────────────────────────────────────────

mv "$APP_DIR" "$FAILED_DIR"
mv "$OLD_DIR" "$APP_DIR"
echo "✓ Swap complete: url-shortener-old → url-shortener"

# ── STEP 5: Start PM2 ─────────────────────────────────────────────────────────

cd "$APP_DIR"
pm2 start ecosystem.config.cjs
pm2 save
echo "✓ PM2 started on restored code"

# ── STEP 6: Health check ──────────────────────────────────────────────────────

retries="${HEALTH_CHECK_RETRIES:-5}"
interval="${HEALTH_CHECK_INTERVAL_SECS:-3}"
ok=0
for i in $(seq 1 "$retries"); do
  echo "  Health check attempt ${i}/${retries}..."
  if curl -sf "${BASE_URL}/health" > /dev/null; then
    ok=1
    break
  fi
  sleep "$interval"
done

# ── STEP 7: Result ────────────────────────────────────────────────────────────

if [[ "$ok" -eq 1 ]]; then
  rm -rf "$FAILED_DIR"
  echo "✓ Rollback successful — previous version is live."
  pm2 list
  exit 0
else
  echo "CRITICAL: Health check failed after rollback."
  echo "  Failed deploy : ${FAILED_DIR}"
  echo "  Restored dir  : ${APP_DIR}"
  echo "  Manual intervention required."
  exit 1
fi
