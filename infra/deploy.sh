#!/usr/bin/env bash
# deploy.sh — bootstrap and deploy Linkly on a fresh Ubuntu/Debian server.
# Run as the deploy user: bash ~/url-shortener/infra/deploy.sh
set -Eeuo pipefail

DEPLOY_ENV="${DEPLOY_ENV:-$HOME/deploy.env}"

if [[ ! -f "$DEPLOY_ENV" ]]; then
  echo "ERROR: $DEPLOY_ENV not found."
  echo "Copy infra/deploy.env.example to $DEPLOY_ENV and fill in the values."
  exit 1
fi

# shellcheck source=/dev/null
source "$DEPLOY_ENV"

log() { printf '\n==> %s\n' "$*"; }
ok() { printf '    OK: %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    run_root docker "$@"
  fi
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_prerequisites() {
  log "Installing server prerequisites"
  [[ "$(uname -s)" == "Linux" ]] || die "This script supports Linux servers only."
  [[ -r /etc/os-release ]] || die "Cannot identify the Linux distribution."
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *debian* ]] || \
    die "Unsupported distribution: ${ID:-unknown}. Use Ubuntu or Debian."

  if [[ "$(id -u)" -ne 0 ]]; then
    require_command sudo
  fi
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl git gnupg lsb-release nginx certbot python3-certbot-nginx \
    ufw unzip

  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
    log "Installing Node.js ${NODE_MAJOR_VERSION:-22}"
    local node_setup
    node_setup="$(mktemp)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_VERSION:-22}.x" -o "$node_setup"
    run_root bash "$node_setup"
    rm -f "$node_setup"
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi

  if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker"
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 || \
      run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-plugin
  elif ! run_root docker compose version >/dev/null 2>&1; then
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 || \
      run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
  fi

  if ! command -v pm2 >/dev/null 2>&1; then
    log "Installing PM2"
    run_root npm install --global pm2
  fi

  log "Enabling system services"
  run_root systemctl enable --now docker nginx
  if [[ "$(id -u)" -ne 0 ]]; then
    run_root usermod -aG docker "$(id -un)"
    echo "    Docker group updated; this run will use sudo until the next login."
  fi
  ok "Node $(node --version), npm $(npm --version), Docker $(docker --version), PM2 $(pm2 --version)"
}

configure_firewall() {
  log "Configuring firewall"
  run_root ufw allow OpenSSH >/dev/null
  run_root ufw allow 80/tcp >/dev/null
  run_root ufw allow 443/tcp >/dev/null
  run_root ufw --force enable >/dev/null
  ok "Only SSH, HTTP, and HTTPS are exposed by UFW"
}

validate_config() {
  local required_vars=(
    REPO_URL APP_DIR DEPLOY_BRANCH
    POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB VALKEY_PASSWORD
    JWT_SECRET JWT_REFRESH_SECRET IP_HASH_SECRET
    BASE_URL REDIRECT_URL CLIENT_ORIGINS
  )
  local missing=0
  for var in "${required_vars[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      echo "ERROR: ${var} is required but not set in ${DEPLOY_ENV}" >&2
      missing=1
    fi
  done
  [[ "$missing" -eq 0 ]] || exit 1

  [[ "$APP_DIR" = /* ]] || die "APP_DIR must be an absolute path."
  [[ "$BASE_URL" == https://* ]] || die "BASE_URL must use https:// in production."
  [[ "$REDIRECT_URL" == https://* ]] || die "REDIRECT_URL must use https:// in production."
  [[ "$BASE_URL" != */ && "$REDIRECT_URL" != */ ]] || die "Public URLs must not end with '/'."
}

url_host() {
  local value="${1#*://}"
  value="${value%%/*}"
  value="${value%%:*}"
  printf '%s' "$value"
}

write_service_env() {
  local target="$1"
  local database_url="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}"
  local valkey_url="redis://:${VALKEY_PASSWORD}@localhost:6379"

  cat > "$target/.env" <<EOF
NODE_ENV=production
PORT=3000
API_HOST=127.0.0.1
DATABASE_URL=${database_url}
VALKEY_URL=${valkey_url}
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

  cat > "$target/../redirect/.env" <<EOF
NODE_ENV=production
PORT=3001
REDIRECT_HOST=127.0.0.1
DATABASE_URL=${database_url}
VALKEY_URL=${valkey_url}
RATE_LIMIT_REDIRECT_LIMIT=${RATE_LIMIT_REDIRECT_LIMIT:-100}
RATE_LIMIT_WINDOW_SECS=${RATE_LIMIT_REDIRECT_WINDOW_SECS:-60}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-30000}
EOF

  cat > "$target/../worker/.env" <<EOF
NODE_ENV=production
DATABASE_URL=${database_url}
VALKEY_URL=${valkey_url}
IP_HASH_SECRET=${IP_HASH_SECRET}
GEO_ENABLED=${GEO_ENABLED:-true}
GEO_TIMEOUT_MS=${GEO_TIMEOUT_MS:-2000}
CLICK_BATCH_SIZE=${CLICK_BATCH_SIZE:-100}
CLICK_FLUSH_MS=${CLICK_FLUSH_MS:-5000}
WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-10}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-30000}
EOF

  chmod 600 "$target/.env" "$target/../redirect/.env" "$target/../worker/.env"
}

write_nginx_config() {
  local api_host redirect_host nginx_file
  api_host="$(url_host "$BASE_URL")"
  redirect_host="$(url_host "$REDIRECT_URL")"
  nginx_file="/etc/nginx/sites-available/linkly.conf"

  [[ -n "$api_host" && -n "$redirect_host" ]] || die "Could not extract hosts from BASE_URL/REDIRECT_URL."

  run_root mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  run_root tee "$nginx_file" >/dev/null <<EOF
server {
    listen 80;
    server_name ${api_host};
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 15s;
        proxy_read_timeout 15s;
    }
}

server {
    listen 80;
    server_name ${redirect_host};
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 15s;
        proxy_read_timeout 15s;
    }
}
EOF

  run_root ln -sfn "$nginx_file" /etc/nginx/sites-enabled/linkly.conf
  run_root rm -f /etc/nginx/sites-enabled/default
  run_root nginx -t
  run_root systemctl reload nginx

  if [[ "${ENABLE_TLS:-true}" == "true" ]]; then
    log "Requesting or renewing TLS certificates"
    local certbot_args=(--nginx --non-interactive --agree-tos --redirect -d "$api_host" -d "$redirect_host")
    if [[ -n "${TLS_EMAIL:-}" ]]; then
      certbot_args+=(--email "$TLS_EMAIL")
    else
      certbot_args+=(--register-unsafely-without-email)
    fi
    [[ "${CERTBOT_STAGING:-false}" == "true" ]] && certbot_args+=(--staging)
    run_root certbot "${certbot_args[@]}"
    run_root nginx -t
    run_root systemctl reload nginx
  else
    echo "WARNING: ENABLE_TLS=false; do not use this mode for production credentials."
  fi
  ok "Nginx proxies ${api_host} to :3000 and ${redirect_host} to :3001"
}

health_check() {
  local retries="${HEALTH_CHECK_RETRIES:-10}"
  local interval="${HEALTH_CHECK_INTERVAL_SECS:-3}"
  local url="${1:-${BASE_URL}/health}"
  for i in $(seq 1 "$retries"); do
    echo "  Health check attempt ${i}/${retries}: ${url}"
    if curl --fail --silent --show-error --max-time 10 "$url" >/dev/null; then
      return 0
    fi
    [[ "$i" -lt "$retries" ]] && sleep "$interval"
  done
  return 1
}

start_pm2() {
  cd "$APP_DIR"
  pm2 delete url-api url-redirect url-worker >/dev/null 2>&1 || true
  pm2 start ecosystem.config.cjs
  pm2 save
}

rollback() {
  local old_dir="${APP_DIR}-old"
  local failed_dir="${APP_DIR}-failed"
  echo "Health check failed; starting rollback."
  pm2 delete url-api url-redirect url-worker >/dev/null 2>&1 || true
  [[ -d "$old_dir" ]] || die "No previous deployment exists at $old_dir."
  rm -rf "$failed_dir"
  mv "$APP_DIR" "$failed_dir"
  mv "$old_dir" "$APP_DIR"
  start_pm2
  if health_check; then
    rm -rf "$failed_dir"
    echo "Rollback completed successfully."
  else
    die "Rollback health check failed. Inspect $failed_dir and $APP_DIR."
  fi
}

main() {
  validate_config
  install_prerequisites
  configure_firewall
  require_command curl
  require_command git
  require_command npm
  require_command pm2
  require_command docker

  local new_dir="${APP_DIR}-new"
  local old_dir="${APP_DIR}-old"
  local failed_dir="${APP_DIR}-failed"
  local compose_project="${COMPOSE_PROJECT_NAME:-linkly}"
  local database_url="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}"

  mkdir -p "$(dirname "$APP_DIR")"
  rm -rf "$new_dir" "$failed_dir"

  log "Cloning ${REPO_URL} (${DEPLOY_BRANCH})"
  git clone --branch "$DEPLOY_BRANCH" --depth 1 "$REPO_URL" "$new_dir"
  local commit
  commit="$(git -C "$new_dir" rev-parse --short HEAD)"

  log "Writing application configuration"
  cat > "$new_dir/.env" <<EOF
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
VALKEY_PASSWORD=${VALKEY_PASSWORD}
EOF
  chmod 600 "$new_dir/.env"
  write_service_env "$new_dir/server/api"
  mkdir -p "$new_dir/logs"
  sed "s|APP_DIR_PLACEHOLDER|${APP_DIR}|g" \
    "$new_dir/infra/ecosystem.config.cjs" > "$new_dir/ecosystem.config.cjs"

  log "Starting PostgreSQL and Valkey"
  docker_cmd compose --project-name "$compose_project" --env-file "$new_dir/.env" \
    -f "$new_dir/docker-compose.yml" up -d

  log "Installing backend dependencies"
  (cd "$new_dir/server" && npm ci)

  log "Generating Prisma clients"
  (cd "$new_dir/server/api" && npx prisma generate)
  (cd "$new_dir/server/redirect" && npx prisma generate)
  (cd "$new_dir/server/worker" && npx prisma generate)

  log "Building backend services"
  (cd "$new_dir/server" && npm run build:shared && npm run build:api && npm run build:redirect && npm run build:worker)

  log "Applying database migrations"
  (cd "$new_dir/server/api" && DATABASE_URL="$database_url" npx prisma migrate deploy)

  log "Installing and validating Nginx routing"
  write_nginx_config

  log "Activating deployment ${commit}"
  pm2 delete url-api url-redirect url-worker >/dev/null 2>&1 || true
  if [[ -d "$APP_DIR" ]]; then
    rm -rf "$old_dir"
    mv "$APP_DIR" "$old_dir"
  fi
  mv "$new_dir" "$APP_DIR"
  start_pm2

  log "Checking application health"
  if ! health_check; then
    rollback
  fi

  echo
  echo "============================================================"
  echo "Linkly deployment complete"
  echo "Commit: ${commit}"
  echo "API: ${BASE_URL}"
  echo "Redirects: ${REDIRECT_URL}"
  echo "Backup: ${old_dir}"
  echo "============================================================"
  pm2 list
}

main "$@"
