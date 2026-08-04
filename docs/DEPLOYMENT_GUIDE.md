# Linkly — Deployment Guide

This is the authoritative deployment reference for the current project. All automation lives in `infra/`. Read this before touching the server.

**What runs where:**

| Component | Host | Manager |
|-----------|------|---------|
| API server (`:3000`) | EC2 | PM2 (`url-api`) |
| Redirect server (`:3001`) | EC2 | PM2 (`url-redirect`) |
| BullMQ worker | EC2 | PM2 (`url-worker`) |
| PostgreSQL (`:5432`) | EC2 Docker | Docker Compose |
| Valkey (`:6379`) | EC2 Docker | Docker Compose |
| Next.js client | Vercel | Vercel |

---

## Part 1 — One-Time EC2 Setup

Do this once when you first provision the server. Never repeat unless you rebuild the instance.

### 1.1 Provision the Instance

Recommended: Amazon Linux 2023, `t3.small` or larger (2 vCPU, 2 GB RAM minimum).

Security group inbound rules:

| Port | Source | Reason |
|------|--------|--------|
| 22 | Your IP only | SSH |
| 80 | 0.0.0.0/0 | HTTP (Certbot challenge + redirect to HTTPS) |
| 443 | 0.0.0.0/0 | HTTPS |

Do **not** open `3000`, `3001`, `5432`, or `6379`. They bind to `127.0.0.1` only.

### 1.2 Install Runtime Dependencies

```bash
# Node.js 22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
nvm alias default 22

# PM2
npm install -g pm2
pm2 startup   # run the printed command to enable PM2 on boot

# Docker
sudo yum install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
# Log out and back in for the group change to take effect

# Docker Compose plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Nginx
sudo yum install -y nginx
sudo systemctl enable --now nginx
```

### 1.3 SSH Deploy Key (EC2 → GitHub)

```bash
ssh-keygen -t ed25519 -C "ec2-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
# Add the printed key to GitHub → repo → Settings → Deploy keys (read-only)

# Verify
ssh -T git@github.com
```

### 1.4 DNS Records

```text
api.example.com  A  <server-ip>
go.example.com   A  <server-ip>
```

The client runs on Vercel — no DNS record needed on EC2 for `app.example.com`.

Wait for DNS propagation before requesting TLS certificates.

### 1.5 Nginx Config

Create `/etc/nginx/conf.d/url-shortener.conf`:

```nginx
server {
    listen 80;
    server_name api.example.com go.example.com;
    return 301 https://$host$request_uri;
}

# Tiered timeout budget (DECISIONS.md #24): nginx is the outermost backstop.
# nginx 504 -> client <=> Fastify request timeout -> Prisma queryTimeout.
# App sends its own envelope+Retry-After for 504 before this ever fires.
# proxy_read_timeout must stay comfortably ABOVE the Prisma query timeout.
proxy_connect_timeout 5s;
proxy_send_timeout    15s;
proxy_read_timeout    15s;

server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl;
    server_name go.example.com;

    ssl_certificate     /etc/letsencrypt/live/go.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/go.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Test and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 1.6 TLS Certificates

```bash
sudo yum install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com -d go.example.com

# Verify auto-renewal
sudo systemctl status certbot-renew.timer
```

### 1.7 Infra Directory and Docker Compose

The `~/infra/` directory on EC2 is maintained manually — it is **not** deployed from the repo. `deploy.sh` writes `~/infra/.env` on every deploy but does not touch `docker-compose.yml`.

```bash
mkdir -p ~/infra
```

Create `~/infra/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:15
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  valkey:
    image: valkey/valkey:7
    restart: unless-stopped
    command: ["valkey-server", "--requirepass", "${VALKEY_PASSWORD}"]
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - valkey_data:/data

volumes:
  postgres_data:
  valkey_data:
```

### 1.8 Create `~/deploy.env`

Copy the template and `deploy.sh` from the repo, then fill in every value:

```bash
scp -i secret.pem infra/deploy.env.example ec2-user@<host>:~/deploy.env
scp -i secret.pem infra/deploy.sh ec2-user@<host>:~/
ssh ec2-user@<host>
chmod 600 ~/deploy.env
nano ~/deploy.env
```

Required variables — `deploy.sh` exits immediately if any are empty:

| Variable | Description |
|----------|-------------|
| `REPO_URL` | SSH clone URL, e.g. `git@github.com:user/repo.git` |
| `APP_DIR` | Absolute path to live app dir, e.g. `/home/ec2-user/url-shortener` |
| `DEPLOY_BRANCH` | Branch to deploy, e.g. `main` |
| `POSTGRES_USER` | PostgreSQL username |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `POSTGRES_DB` | PostgreSQL database name |
| `VALKEY_PASSWORD` | Valkey auth password (mirrors `--requirepass` in docker-compose.yml) |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | `openssl rand -hex 32` |
| `IP_HASH_SECRET` | `openssl rand -hex 32` |
| `BASE_URL` | Public API URL, e.g. `https://api.example.com` |
| `REDIRECT_URL` | Public redirect URL, e.g. `https://go.example.com` |
| `CLIENT_ORIGINS` | Comma-separated CORS origins, e.g. `https://app.example.com` |

Optional variables have defaults in `deploy.sh` — see `infra/deploy.env.example` for the full list.

---

## Part 2 — Every Deploy

After one-time setup is done, every deploy (first and subsequent) is a single command:

```bash
bash ~/deploy.sh
```

Or, if you prefer to run it from the cloned repo location:

```bash
bash ~/url-shortener/infra/deploy.sh
```

### What `deploy.sh` Does (in order)

1. Sources `~/deploy.env` — exits if file missing or any required variable is empty
2. Pre-flight cleanup — removes leftover `url-shortener-new/`, `url-shortener-old/`, `url-shortener-failed/` from any previous failed run
3. `git clone` the repo into `url-shortener-new/`
4. Writes `.env` files for `server/api`, `server/redirect`, `server/worker`, and `client/` from `deploy.env` values
5. Writes `~/infra/.env` for Docker Compose
6. `docker compose up -d` — starts/updates PostgreSQL and Valkey
7. `npm ci` in `server/`
8. `prisma generate` in all three server packages — **must run before the TypeScript build** because `api`, `redirect`, and `worker` all import from the generated client (`src/generated/prisma/`); without this step `tsc` cannot find the module and the build fails
9. Builds: `shared` → `api` → `redirect` → `worker` (in that order)
10. `prisma migrate deploy` from `server/api` only — applies any pending schema migrations against the live database
11. Generates `ecosystem.config.cjs` by substituting `APP_DIR_PLACEHOLDER` with the real path
12. `sudo nginx -t` — aborts if Nginx config is invalid (live server stays up)
13. `pm2 stop all`
14. Blue-green swap: `url-shortener/` → `url-shortener-old/`, `url-shortener-new/` → `url-shortener/`
15. `pm2 start ecosystem.config.cjs && pm2 save`
16. Health check: `GET ${BASE_URL}/health` — retries `HEALTH_CHECK_RETRIES` times with `HEALTH_CHECK_INTERVAL_SECS` delay
17. On health check pass: `sudo systemctl reload nginx` → done
18. On health check fail: auto-rollback (see Part 3)

### Filesystem at Steady State

```
/home/ec2-user/
├── deploy.sh                   ← standalone entry point, kept fresh by deploy.sh
├── deploy.env                  ← secrets (chmod 600, never committed)
├── deploy.env.example          ← reference template, safe to keep
├── infra/
│   ├── docker-compose.yml      ← maintained manually on EC2
│   └── .env                    ← written by deploy.sh on every deploy
├── url-shortener/              ← live app (APP_DIR)
│   ├── server/
│   │   ├── api/dist/
│   │   ├── redirect/dist/
│   │   └── worker/dist/
│   ├── ecosystem.config.cjs    ← generated by deploy.sh
│   └── logs/
└── url-shortener-old/          ← previous deploy (kept for manual rollback)
```

During a deploy, `url-shortener-new/` exists briefly until the swap.

---

## Part 3 — Rollback

### Automatic Rollback

If the health check in Step 15 fails, `deploy.sh` automatically:

1. `pm2 stop all`
2. Moves `url-shortener/` → `url-shortener-failed/`
3. Moves `url-shortener-old/` → `url-shortener/`
4. `pm2 start ecosystem.config.cjs`
5. Re-runs the health check on the restored version

If the restored version passes: exits with code 1, `url-shortener-failed/` is deleted.  
If the restored version also fails: exits with code 1, both dirs preserved — manual intervention required.

### Manual Rollback

Use this when the automatic rollback didn't run (e.g. you deployed manually) or you want to roll back after a successful deploy that turned out to be broken:

```bash
bash ~/url-shortener/infra/rollback.sh
```

`rollback.sh` requires `url-shortener-old/` to exist. It does the same swap + health check as the auto-rollback path.

---

## Part 4 — Vercel Client Deployment

The Next.js client (`client/`) deploys to Vercel, not EC2.

1. Connect the repo to a Vercel project.
2. Set the root directory to `client/`.
3. Add environment variable in Vercel project settings:
   ```
   NEXT_PUBLIC_API_BASE_URL=https://api.example.com
   ```
4. Every push to `main` triggers a Vercel build automatically.

The `client/.env.production.local` that `deploy.sh` writes is for local reference only — Vercel ignores it.

**Important:** `CLIENT_ORIGINS` in `deploy.env` must include the Vercel deployment URL (e.g. `https://app.example.com`). If it doesn't, every API call from the browser will fail with a CORS error.

---

## Part 5 — Common Deployment Errors and Fixes

### deploy.sh Errors

**`ERROR: ~/deploy.env not found`**

`deploy.sh` looks for `~/deploy.env` on the EC2 instance. It does not exist yet.

```bash
scp infra/deploy.env.example ec2-user@<host>:~/deploy.env
ssh ec2-user@<host> "nano ~/deploy.env"
```

---

**`ERROR: <VAR> is required but not set in deploy.env`**

A required variable in `~/deploy.env` is empty or missing. Open the file and fill in the value.

```bash
nano ~/deploy.env
```

The script prints every missing variable before exiting — fix all of them at once.

---

**`ERROR: git clone failed`**

Causes (in order of likelihood):

1. SSH deploy key not added to GitHub — `cat ~/.ssh/id_ed25519.pub` → GitHub repo → Settings → Deploy keys → Add key (read-only)
2. Wrong `REPO_URL` in `deploy.env` — must be the SSH form `git@github.com:user/repo.git`, not HTTPS
3. `DEPLOY_BRANCH` doesn't exist in the remote

```bash
# Test SSH access
ssh -T git@github.com

# Test clone manually
git clone git@github.com:user/repo.git /tmp/test-clone
```

---

**`ERROR: Build failed`**

The build step runs `build:shared` → `build:api` → `build:redirect` → `build:worker`. If any fails, `deploy.sh` deletes `url-shortener-new/` and exits. The live server is untouched.

To debug:

```bash
# Reproduce the build manually in the new dir
cd ~/url-shortener-new/server
npm ci
npm run build:shared
npm run build:api
npm run build:redirect
npm run build:worker
```

Common causes:

- TypeScript errors introduced in the new commit
- `@url-shortener/shared` not built before `api`/`redirect`/`worker` — the build scripts in `server/package.json` must run `build:shared` first
- Missing `node_modules` — `npm ci` failed silently (check for npm registry errors above the build output)
- Prisma client not generated before the build — if reproducing manually, run `npx prisma generate` inside each of `server/api`, `server/redirect`, and `server/worker` before running the build commands (Step 8 in the automated script handles this)

---

**`ERROR: Migration failed. DB state unknown`**

`prisma migrate deploy` failed. The script exits without swapping — the live server is still running the old code.

```bash
# Check what migrations are pending
cd ~/url-shortener-new/server/api
DATABASE_URL="postgresql://..." npx prisma migrate status

# Check PostgreSQL is reachable
docker compose --project-directory ~/infra --env-file ~/infra/.env ps
docker compose --project-directory ~/infra --env-file ~/infra/.env logs postgres
```

Do **not** run `prisma migrate deploy` from `server/redirect` or `server/worker` — they have schema copies for client generation only.

---

**`ERROR: Nginx config invalid`**

`sudo nginx -t` failed. The script aborts before stopping PM2 — the live server is untouched.

```bash
sudo nginx -t
# Output shows the file and line number with the syntax error
sudo nano /etc/nginx/conf.d/url-shortener.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

**`Health check failed — initiating auto-rollback`**

The new code started but `GET ${BASE_URL}/health` didn't return 200 within the retry window. Auto-rollback runs automatically.

To find the cause:

```bash
# Check what the new processes logged before they were stopped
cat ~/url-shortener-failed/logs/api-error.log
cat ~/url-shortener-failed/logs/api-out.log

# Or check PM2 logs if processes are still running
pm2 logs url-api --lines 100
pm2 logs url-redirect --lines 100
pm2 logs url-worker --lines 100
```

Common causes:

- Missing or wrong env variable in `deploy.env` (e.g. wrong `DATABASE_URL`, missing `JWT_SECRET`)
- Port already in use — another process is on `3000` or `3001`
- `dist/server.js` not found — build succeeded but the output path doesn't match `ecosystem.config.cjs`

---

**`CRITICAL: Rollback health check also failed`**

Both the new deploy and the old backup are failing the health check. This is the worst case.

Immediate steps:

```bash
# 1. Check what's running
pm2 list
pm2 logs --lines 200

# 2. Check if Docker containers are up
docker compose --project-directory ~/infra --env-file ~/infra/.env ps

# 3. Check if PostgreSQL is accepting connections
docker compose --project-directory ~/infra --env-file ~/infra/.env exec postgres \
  psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT 1"

# 4. Check Nginx
sudo systemctl status nginx
sudo nginx -t

# 5. Try starting PM2 manually
cd ~/url-shortener
pm2 start ecosystem.config.cjs
pm2 logs url-api --lines 50
```

If the database has a bad migration that broke both versions, you may need to restore from a PostgreSQL backup.

---

### PM2 Errors

**`pm2: command not found`**

PM2 is not on PATH. This happens when nvm is not sourced.

```bash
source ~/.bashrc
# or
export PATH="$HOME/.nvm/versions/node/v22.x.x/bin:$PATH"
npm install -g pm2
```

---

**`Error: Cannot find module 'dist/server.js'`** (in PM2 logs)

The build didn't produce output at the expected path, or the `cwd` in `ecosystem.config.cjs` is wrong.

```bash
# Check what was actually built
ls ~/url-shortener/server/api/dist/
ls ~/url-shortener/server/redirect/dist/
ls ~/url-shortener/server/worker/dist/

# Check the generated ecosystem config
cat ~/url-shortener/ecosystem.config.cjs
```

The `ecosystem.config.cjs` is generated by `deploy.sh` by replacing `APP_DIR_PLACEHOLDER` with the real `APP_DIR`. If `APP_DIR` in `deploy.env` has a trailing slash or typo, the paths will be wrong.

---

**`Error: Cannot find module '@url-shortener/shared'`** (in PM2 logs)

The shared package was not built before the dependent services.

```bash
cd ~/url-shortener/server
npm run build:shared
npm run build:api
npm run build:redirect
npm run build:worker
pm2 restart all
```

---

**PM2 process shows `errored` status**

```bash
pm2 logs url-api --lines 100
pm2 logs url-redirect --lines 100
pm2 logs url-worker --lines 100

# Also check the log files directly
cat ~/url-shortener/logs/api-error.log
cat ~/url-shortener/logs/redirect-error.log
cat ~/url-shortener/logs/worker-error.log
```

---

### Docker / Database Errors

**`docker: permission denied`**

`ec2-user` is not in the `docker` group.

```bash
sudo usermod -aG docker ec2-user
# Log out and back in — the group change requires a new session
```

---

**`Error: connect ECONNREFUSED 127.0.0.1:5432`** (in API/worker logs)

PostgreSQL container is not running.

```bash
docker compose --project-directory ~/infra --env-file ~/infra/.env ps
docker compose --project-directory ~/infra --env-file ~/infra/.env up -d
docker compose --project-directory ~/infra --env-file ~/infra/.env logs postgres
```

---

**`FATAL: password authentication failed for user`**

`POSTGRES_PASSWORD` in `deploy.env` doesn't match what the container was initialized with. PostgreSQL stores credentials in the data volume — changing the env var after first init has no effect.

Options:
1. Use the original password
2. Delete the volume and re-initialize (loses all data): `docker compose --project-directory ~/infra down -v && docker compose --project-directory ~/infra up -d`

---

**`WRONGPASS invalid username-password pair`** (Valkey connection error)

`VALKEY_PASSWORD` in `deploy.env` doesn't match `--requirepass` in `docker-compose.yml`.

```bash
# Check what password the container is using
docker compose --project-directory ~/infra --env-file ~/infra/.env exec valkey \
  valkey-cli -a "$VALKEY_PASSWORD" PING
```

If the container was started without a password and you're adding one now, restart it:

```bash
docker compose --project-directory ~/infra --env-file ~/infra/.env down
docker compose --project-directory ~/infra --env-file ~/infra/.env up -d
```

---

**`Can't connect to Valkey`** — rate limiting and caching fail open

The API and redirect servers are designed to fail open on Valkey errors (rate limiting allows, cache misses). The worker will fail to process jobs. Check:

```bash
docker compose --project-directory ~/infra --env-file ~/infra/.env ps
# Verify VALKEY_URL in the .env files includes the password:
# redis://:PASSWORD@localhost:6379
grep VALKEY_URL ~/url-shortener/server/api/.env
```

---

### Nginx Errors

**`502 Bad Gateway`**

Nginx is running but the upstream Node process is not.

```bash
pm2 list
pm2 logs url-api --lines 50
# If the process is stopped or errored, restart it:
pm2 restart url-api
```

---

**`SSL_ERROR_RX_RECORD_TOO_LONG` or blank page on HTTPS**

Nginx is serving HTTP on port 443. The TLS certificate block is missing or Certbot hasn't run yet.

```bash
sudo certbot --nginx -d api.example.com -d go.example.com
sudo nginx -t && sudo systemctl reload nginx
```

---

**`CORS error` in browser console**

`CLIENT_ORIGINS` in `deploy.env` doesn't include the exact origin the browser is calling from (scheme + host + port).

```bash
# Check what the API server has
grep CLIENT_ORIGINS ~/url-shortener/server/api/.env
# Must match exactly, e.g. https://app.example.com (no trailing slash)
```

Update `deploy.env`, then redeploy or manually update the `.env` file and restart:

```bash
pm2 restart url-api
```

---

### Auth / Cookie Errors

**Refresh token cookie not sent / login works but page reload logs out**

Causes:

1. `NODE_ENV` is not `production` — the `Secure` flag is only set when `NODE_ENV=production`. Check `~/url-shortener/server/api/.env`.
2. API and client are on different parent domains — `SameSite=Strict` cookies won't cross domains. Both must share a parent domain (e.g. `api.example.com` and `app.example.com`).
3. The browser is on HTTP, not HTTPS — `Secure` cookies are not sent over HTTP.

---

## Part 6 — Debugging by Component

Use this section when you know something is broken but not which component.

### Step 1: Check the Health Endpoint

```bash
curl -v https://api.example.com/health
```

- `200 {"status":"ok"}` — API is up, DB connection is healthy
- `502` — PM2 process is down (go to Step 2)
- `Connection refused` — Nginx is down (`sudo systemctl status nginx`)
- `SSL error` — TLS cert issue (`sudo certbot renew`)

### Step 2: Check PM2 Process Status

```bash
pm2 list
```

Look at the `status` column:

- `online` — process is running
- `stopped` — process was stopped manually
- `errored` — process crashed on startup (check logs immediately)

```bash
pm2 logs url-api --lines 100
pm2 logs url-redirect --lines 100
pm2 logs url-worker --lines 100
```

### Step 3: Check Docker Containers

```bash
docker compose --project-directory ~/infra --env-file ~/infra/.env ps
```

Both `postgres` and `valkey` should show `running`. If not:

```bash
docker compose --project-directory ~/infra --env-file ~/infra/.env up -d
docker compose --project-directory ~/infra --env-file ~/infra/.env logs
```

### Step 4: Verify Connectivity

```bash
# PostgreSQL
docker compose --project-directory ~/infra --env-file ~/infra/.env exec postgres \
  psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT version()"

# Valkey
docker compose --project-directory ~/infra --env-file ~/infra/.env exec valkey \
  valkey-cli -a "$VALKEY_PASSWORD" PING
```

### Step 5: Check Nginx

```bash
sudo systemctl status nginx
sudo nginx -t
sudo journalctl -u nginx --since "10 minutes ago"
```

### Step 6: Check Log Files

PM2 writes logs to `~/url-shortener/logs/`:

```bash
tail -f ~/url-shortener/logs/api-error.log
tail -f ~/url-shortener/logs/redirect-error.log
tail -f ~/url-shortener/logs/worker-error.log
```

### Step 7: Verify Environment Variables

If a process starts but behaves wrong (wrong URLs, auth failures, CORS errors):

```bash
cat ~/url-shortener/server/api/.env
cat ~/url-shortener/server/redirect/.env
cat ~/url-shortener/server/worker/.env
```

These files are written by `deploy.sh` from `~/deploy.env`. If a value is wrong, fix `~/deploy.env` and redeploy.

### Step 8: Check the BullMQ Worker

If redirects work but analytics don't appear:

```bash
pm2 logs url-worker --lines 100

# Check queue depth
docker compose --project-directory ~/infra --env-file ~/infra/.env exec valkey \
  valkey-cli -a "$VALKEY_PASSWORD" LLEN "bull:click:wait"
```

A large queue depth with no worker processing means the worker is down or crashing on job processing.

---

## Part 7 — Smoke Test After Every Deploy

Run these after every successful deploy to confirm the system is working end-to-end.

```bash
# 1. API health
curl https://api.example.com/health
# Expected: {"status":"ok","timestamp":"...","db":"ok"}

# 2. PM2 status
pm2 list
# All three processes: online

# 3. Redirect server (returns 404 if no URLs exist yet — that's fine)
curl -I https://go.example.com/test123
# Expected: 404 (not 502, not connection refused)

# 4. Worker logs — no repeated errors
pm2 logs url-worker --lines 20 --nostream
```

Then in the browser:

1. Open `https://app.example.com` (Vercel client)
2. Register or log in
3. Create a short URL — the returned link should use `https://go.example.com/...`
4. Open the short URL — should 302 to the original destination
5. Check analytics — click data should appear after a few seconds (worker processes async)

---

## Part 8 — Monitoring Checklist

Minimum ongoing checks:

```bash
# Process health
pm2 list
pm2 monit

# Disk usage (two full app copies exist during deploy)
df -h

# Docker container health
docker compose --project-directory ~/infra --env-file ~/infra/.env ps

# Nginx errors
sudo journalctl -u nginx --since "1 hour ago" | grep -i error

# TLS cert expiry
sudo certbot certificates
```

Set up an external uptime monitor on `https://api.example.com/health`. If it goes down, you want to know before users do.

---

## Part 9 — Disk Management

`deploy.sh` keeps at most two full copies of the app on disk at any time:

| Directory | Deleted when |
|-----------|-------------|
| `url-shortener-new/` | On build/migration failure, or at start of next deploy (pre-flight cleanup) |
| `url-shortener-old/` | At start of next successful deploy (pre-flight cleanup) |
| `url-shortener-failed/` | After successful auto-rollback or manual rollback |

If disk fills up during a deploy (build fails with no space left):

```bash
df -h
# Manually clean up if pre-flight didn't run
rm -rf ~/url-shortener-new ~/url-shortener-old ~/url-shortener-failed
```

---

## Part 10 — Quick Reference

```bash
# Deploy
bash ~/url-shortener/infra/deploy.sh

# Manual rollback
bash ~/url-shortener/infra/rollback.sh

# Check all processes
pm2 list

# Tail all logs
pm2 logs

# Restart a single service
pm2 restart url-api
pm2 restart url-redirect
pm2 restart url-worker

# Check Docker containers
docker compose --project-directory ~/infra --env-file ~/infra/.env ps

# Restart Docker containers
docker compose --project-directory ~/infra --env-file ~/infra/.env up -d

# Nginx reload (after config change)
sudo nginx -t && sudo systemctl reload nginx

# Health check
curl https://api.example.com/health
```
