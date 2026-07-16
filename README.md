# Linkly — Shorten your URL in seconds and keep records

High-throughput URL shortening system with first-class click analytics. Built for low-latency redirects (sub-10ms p99) and horizontal scalability. Separates URL creation from redirect serving to allow independent scaling of read-heavy workloads.

**Ownership:** Sagar Kumar

---

## Core Functionality

- Synchronous URL creation with Base62-encoded short codes generated from PostgreSQL sequences (no collision retries, enumeration-resistant)
- Sub-10ms redirects via L1 (in-process LRU) → L2 (Valkey) → L3 (PostgreSQL) cache-aside lookup with 302 temporary redirects (not 301, to preserve analytics on every click)
- Asynchronous click analytics via BullMQ queue — IP geolocation, User-Agent parsing, and click event insertion never block redirect latency (fire-and-forget pattern)
- JWT-based authentication with 15-minute access tokens (in-memory on client) and Argon2id-hashed refresh tokens stored in PostgreSQL (revocable, enables session management)
- Per-URL analytics: click counts, geographic breakdown, referrer tracking, device classification, time-series aggregation

---

## System Capabilities & Architecture

### Performance Targets

| Metric | Target |
|--------|--------|
| Redirect p99 latency | < 10 ms |
| URL creation p95 latency | < 200 ms |
| Analytics query | < 500 ms |
| Redirect throughput | 115,000 req/s |
| URL creation throughput | 1,160 req/s |
| Availability | 99.9% |

### Load Characteristics

- Read-to-write ratio: 100:1 to 1000:1 (redirects vs. creations)
- Storage growth: ~50GB/day at 100M URLs/day (500 bytes avg per URL record)
- Click events: append-only, partitioned by month, retained for 90 days raw then aggregated

### Architecture Overview

```
┌─────────────────┐     ┌──────────────────────────────────────────────────┐
│   Next.js UI    │────▶│              Nginx / Load Balancer                │
└─────────────────┘     └──────────┬────────────────────────┬───────────────┘
                                   │                        │
                         ┌─────────▼──────┐      ┌─────────▼──────────┐
                         │   API Server   │      │  Redirect Server   │
                         │   (Fastify)    │      │   (Fastify, RO)    │
                         │  Auth, CRUD,   │      │  /:shortCode →     │
                         │  Analytics     │      │  302 redirect      │
                         └────────┬───────┘      └────────┬───────────┘
                                  │                       │
                         ┌────────▼───────────────────────▼───────────┐
                         │           Valkey (Redis-compatible)         │
                         │   L2 cache · Rate limiting · BullMQ queue  │
                         └────────────────────────┬────────────────────┘
                                                  │
                         ┌────────────────────────▼────────────────────┐
                         │              PostgreSQL                      │
                         │  Primary + Read Replicas (partitioned)      │
                         └─────────────────────────────────────────────┘
```

**Design Decisions:**
- 302 redirects (not 301) ensure every click hits the server for analytics
- Cache-aside pattern populates L2 cache only on access, not on creation (power-law traffic distribution)
- Separate `api` (:3000) and `redirect` (:3001) processes allow independent scaling of the hot read path
- BullMQ queue decouples redirect latency from DB write throughput for click events

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 20.9+ (Node 22 LTS recommended) |
| Docker | Latest |
| Docker Compose | Latest (v2.x) |
| Operating System | Linux, macOS, Windows (WSL2 recommended) |

---

## Environment Variables & Configuration

### Infrastructure (Docker Compose)

PostgreSQL and Valkey are started via Docker Compose at the repo root:

```bash
docker compose up -d
```

Credentials come from a root-level `.env` (gitignored, never committed) — copy
`.env.example` to `.env` first:

```bash
cp .env.example .env   # fill in POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
docker compose up -d
```

Valkey needs no credentials for local development: `redis://localhost:6379`.

### API Server (`server/api/`)

Create `.env` from `.env.example`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://user:password@localhost:5432/database` | PostgreSQL connection string |
| `VALKEY_URL` | No | `redis://localhost:6379` | Valkey/Redis connection string |
| `JWT_SECRET` | Yes | — | Secret for signing/verifying JWT access tokens. No fallback — server refuses to start without it |
| `JWT_REFRESH_SECRET` | Yes | — | Secret for signing/verifying JWT refresh tokens. No fallback — server refuses to start without it |
| `BASE_URL` | Yes | `http://localhost:3000` | Public base URL for constructing short links |
| `NODE_ENV` | No | `development` | `development` \| `production` \| `test` |
| `PORT` | No | `3000` | API server port |
| `DEFAULT_URL_TTL_DAYS` | No | `7` | Default expiry when no `ttlDays` provided |

### Redirect Server (`server/redirect/`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://user:password@localhost:5432/database` | PostgreSQL connection string |
| `VALKEY_URL` | No | `redis://localhost:6379` | Valkey/Redis connection string |
| `BASE_URL` | Yes | `http://localhost:3000` | Public base URL for constructing short links |
| `NODE_ENV` | No | `development` | `development` \| `production` \| `test` |
| `PORT` | No | `3001` | Redirect server port |
| `RATE_LIMIT_REDIRECT_LIMIT` | No | `100` | Max redirects per window per IP |
| `RATE_LIMIT_WINDOW_SECS` | No | `60` | Rate limit window in seconds |

### Worker (`server/worker/`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://user:password@localhost:5432/database` | PostgreSQL connection string |
| `VALKEY_URL` | No | `redis://localhost:6379` | Valkey/Redis connection string |
| `NODE_ENV` | No | `development` | `development` \| `production` \| `test` |
| `PORT` | No | `3000` | Worker port (for health checks) |
| `IP_HASH_SECRET` | Yes | — | Secret for hashing IPs (generate: `openssl rand -hex 32`) |
| `GEO_ENABLED` | No | `true` | Enable/disable IP geolocation |
| `GEO_TIMEOUT_MS` | No | — | Geolocation API timeout in milliseconds |
| `WORKER_CONCURRENCY` | No | `10` | Number of concurrent jobs to process |

### Next.js Client (`client/`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_API_BASE_URL` | No | `http://localhost:3000` | API origin. Must be in API's CORS allow-list. Client must run on port 3002. |

---

## ⚠️ Secret Rotation Warning

A source-code security pass (2026-07-15) found and removed the following **hardcoded
fallback secrets**, which had been committed to this repository:

- `server/api/src/config.ts` — `JWT_SECRET` and `JWT_REFRESH_SECRET` silently fell back to
  the literal strings `'default_jwt_secret'` / `'default_jwt_refresh_secret'` when the
  corresponding env var was unset.
- `server/worker/src/config.ts` — `IP_HASH_SECRET` silently fell back to
  `'dev_ip_hash_secret_change_me'`.
- `docker-compose.yml` — the local Postgres container's `POSTGRES_USER`/`POSTGRES_PASSWORD`
  were hardcoded as `admin` / `secret`.

These values are visible in this repo's git history even though the code no longer uses
them (the services now fail fast at startup instead of silently defaulting). **If any
deployment ever ran without explicitly setting `JWT_SECRET`, `JWT_REFRESH_SECRET`, or
`IP_HASH_SECRET`, or if the Postgres container was ever reachable from outside localhost,
rotate those credentials immediately** — generate new random values (`openssl rand -hex 32`),
set them via env vars, and redeploy. Rotating `JWT_SECRET`/`JWT_REFRESH_SECRET` invalidates
all existing sessions, which is expected.

---

## 🔐 Personal Data & Privacy

A personal-data flow audit (2026-07-15) mapped every place the app collects user data and
where it goes. Summary — full detail in `docs/notes/API_CONTRACT.md` and
`docs/notes/DECISIONS.md` (#13, #14):

| Data | Collected at | Stored as | Leaves the app? |
|---|---|---|---|
| Email, password | Register/login | `users.email` (plain), `users.password_hash` (Argon2id) | No |
| Refresh token | Login/register/refresh | `refresh_tokens.token_hash` (SHA-256); raw token only ever in an httpOnly, SameSite=Strict cookie | No |
| Browser User-Agent (account-linked) | Login/register/refresh | `refresh_tokens.user_agent` (raw string) | No |
| Destination URL, alias | URL creation | `urls.original_url`, `urls.custom_alias` | No |
| Visitor IP | Every redirect | `click_events.ip_hash` — SHA-256 with a daily-rotating salt; **raw IP is never persisted** | **Yes** — see below |
| Visitor User-Agent, Referrer | Every redirect | Parsed into `device_type`/`browser`/`os` and `referrer_domain` (hostname only); raw strings discarded | No |

**The one external data flow:** the worker sends the visitor's raw IP to a third-party
geo-IP service (`ip-api.com`) to resolve a country code, over **plain HTTP** (the free tier
doesn't support TLS). This is inherent to how geo-IP lookups work and is gated by
`GEO_ENABLED`/fails open on error — but it's worth knowing this is the only point where raw
personal data (an IP address) leaves the app's own infrastructure. Only `countryCode` is
requested/stored as of this audit (previously `city` was also fetched and stored with no
consumer — removed as unnecessary data collection, see Decision 14).

**Fixed in this audit:**
- A worker debug log was printing the raw visitor IP (`analytics.job.ts`) — contradicted the
  codebase's own "raw IP is never logged" guarantee. Removed.
- `city`-level geo data was requested from and stored via the third party with no feature
  using it — dropped (`countryCode` only now).
- A stray `console.log` in the client's links page was dumping full URL list data to the
  browser console — removed.
- **Account deletion did not exist.** Added `DELETE /api/auth/account` — anonymizes the
  account (email/name/password overwritten, deactivated), soft-deletes all owned URLs
  (click-event history is preserved, same policy as manual URL deletion), and purges the
  user's refresh tokens (including the stored User-Agent string). Requires the current
  password. See Decision 13.

---

## Local Setup and Installation

### 1. Start Infrastructure Services

From the repo root:

```bash
cp .env.example .env   # fill in POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
docker compose up -d
```

This starts PostgreSQL on `:5432` and Valkey on `:6379`.

Verify services are running:

```bash
docker compose ps
```

### 2. Setup API Server

```bash
cd server/api
cp .env.example .env        # Fill in values (see Environment Variables section)
npm install
npx prisma migrate dev      # Run database migrations
npm run dev                 # Start dev server on http://localhost:3000
```

### 3. Setup Redirect Server

```bash
cd server/redirect
npm install
npm run dev                 # Starts on http://localhost:3001
```

Check all the happy logs in the console

### 4. Setup Worker

```bash
cd server/worker
npm install
npm run dev                 # Starts BullMQ worker process
```

Check all the happy logs in the console

### 5. Setup Next.js Client

From the repo root:

```bash
npm --prefix client install
npm --prefix client run dev
```

Client runs on **http://localhost:3002** (hardcoded — API CORS allow-list only permits `http://localhost:3002`).

**Verification:**
- API health check: `curl http://localhost:3000/health` → `{"status":"ok"}`
- Redirect server: Visit `http://localhost:3001/:shortCode` (returns 404 if no URLs created yet)
- Client: Open `http://localhost:3002` in browser

---

## Testing

### API Server Tests

```bash
cd server/api
npm test                    # TODO: Add test command
npm run type-check          # `tsc --noEmit`
```

TODO: Add unit test coverage details and E2E test commands

### Redirect Server Tests

```bash
cd server/redirect
npm test                    # TODO: Add test command
```

TODO: Add test suite details

### Worker Tests

```bash
cd server/worker
npm test                    # Run all tests with coverage (Vitest)
npm run test:unit           # Unit tests only (no DB required)
npm run test:integration    # Integration tests only (requires DATABASE_URL_TEST)
npm run test:watch          # Watch mode for development
npm run type-check          # TypeScript type checking
```

**Test Framework:** Vitest with v8 coverage

**Test Structure:**
- `tests/unit/` — Pure unit tests with mocked repositories (no database)
- `tests/integration/` — Real PostgreSQL tests against `DATABASE_URL_TEST`

**Unit Test Suites:**
| File | Coverage |
|------|----------|
| `aggregation-window.test.ts` | IST date math boundary conditions (Layer 1 — pure functions, no DB) |
| `aggregation-job.test.ts` | Job orchestration logic with fake repos, cron error handling (Layer 2) |
| `expiry-job.test.ts` | Expiry sweep job with fake repos, error handling (Layer 2) |
| `schedule.test.ts` | Cron expression + timezone validation (Layer 5) |

**Integration Test Suites:**
| File | Coverage |
|------|----------|
| `aggregate.repository.integration.test.ts` | Real aggregation SQL with IST bucketing via `AT TIME ZONE 'Asia/Kolkata'`, JSONB aggregation, ON CONFLICT idempotency (Layer 3) |
| `url.repository.integration.test.ts` | Soft-delete expiry sweep against real Postgres, idempotency, boundary conditions (Layer 3) |

**Integration Test Requirements:**
- Set `DATABASE_URL_TEST` to a test database (must contain "test" in name for safety)
- Docker Compose must be running: `docker compose up -d`
- Example: `DATABASE_URL_TEST=postgresql://dev:dev@localhost:5432/urlshortener_test`

**Coverage Scope:**
- Includes: `src/jobs/**`, `src/repositories/**`
- Excludes: CLI wrappers (`run-aggregation.ts`, `run-expiry.ts`), generated Prisma client, wiring entry point
- Reports: `tests/coverage/` (HTML + text terminal)

### Client Tests

```bash
cd client
npm run lint                # ESLint (flat config)
npm run type-check          # `tsc --noEmit`
npm test                    # TODO: Add test command
```

TODO: Add test suite details

---

## Deployment and CI/CD

**CI/CD Pipeline:** TODO: Add CI/CD pipeline details (e.g., GitHub Actions to AWS ECS)

### Build Commands

**API Server:**
```bash
cd server/api
npm run build              # Compile TypeScript to dist/
npm start                  # Run compiled output (dist/server.js)
```

**Redirect Server:**
```bash
cd server/redirect
npm run build
npm start
```

**Worker:**
```bash
cd server/worker
npm run build
npm start
```

**Client:**
```bash
cd client
npm run build              # Production build
npm run start              # Serve production build on :3002
```

### Docker Deployment

TODO: Add Dockerfile locations and build/deploy commands

### Health Checks

- API: `GET /health` → `{"status":"ok"}`
- Redirect: TODO: Add health check endpoint
- Worker: TODO: Add health check mechanism

---

## Runbooks, Observability, and Troubleshooting

### Observability Tools

TODO: Add observability stack (e.g., Datadog, Sentry, Prometheus, Grafana)

### Logging

All services use **Pino** with `pino-pretty` for structured JSON logging in development. Log format includes request IDs, timestamps, and error stacks.

### Common Issues

**Port conflicts:**
- API server must run on `:3000` (hardcoded in client config)
- Redirect server defaults to `:3001` — ensure it's free
- Client must run on `:3002` (CORS allow-list requirement)

**Database connection failures:**
- Verify PostgreSQL is running: `docker compose ps`
- Check credentials in `DATABASE_URL` match docker-compose.yml
- Ensure migrations have run: `npx prisma migrate status`

**Cache misses:**
- Verify Valkey is running: `docker compose ps`
- Check `VALKEY_URL` matches docker-compose.yml
- Redis CLI: `docker compose exec valkey redis-cli PING`

**CORS errors:**
- Client must run on `http://localhost:3002`
- Check API server CORS configuration includes client origin

**Authentication failures:**
- Verify `JWT_SECRET` is set in API server `.env`
- Check refresh token cookie is being sent (`credentials: "include"` in client fetch)
- Ensure token hasn't expired (access token: 15 min, refresh token: 30 days)

### Performance Troubleshooting

**Redirect latency > 10ms:**
- Check Valkey hit rate: `redis-cli INFO stats`
- Verify L1/L2 cache population in logs
- Check for thundering herd on cache expiry (mitigate with probabilistic early expiry)

**Click events not appearing:**
- Verify worker process is running
- Check BullMQ queue depth: `redis-cli LLEN bull:click:wait`
- Review worker logs for failed jobs

**Analytics queries slow:**
- Check `click_events` partition pruning (queries should scan only relevant months)
- Verify indexes on `clicked_at`, `url_id`
- Consider pre-aggregation for large datasets

### Runbook Links

TODO: Add link to detailed runbooks for:
- Incident response procedures
- Database backup/restore
- Cache warmup procedures
- Scaling playbook
- Secrets rotation

---

## Project Structure

```
url-shortener/                     # Monorepo root
├── docker-compose.yml             # PostgreSQL + Valkey
├── docs/                          # System design, API contracts, decisions
│   ├── overview/
│   ├── notes/
│   └── sections/
├── server/                        # Backend root
│   ├── api/                       # Fastify API server (:3000)
│   │   ├── prisma/               # Schema + migrations
│   │   └── src/                  # Routes, services, repositories
│   ├── redirect/                 # Fastify redirect server (:3001)
│   ├── worker/                   # BullMQ worker for async jobs
│   ├── shared/                   # Shared utilities, config, logger
│   └── docs/                     # Backend-specific docs
└── client/                        # Next.js App Router dashboard
    ├── src/
    │   ├── app/                  # Routes (landing, auth, dashboard)
    │   ├── components/           # UI components (shadcn/ui based)
    │   ├── lib/                  # API client, types, config
    │   ├── hooks/                # TanStack Query hooks
    │   └── providers/            # Theme, auth, query providers
    └── package.json
```

---

## Key Design Documents

| Document | Contents |
|----------|----------|
| `docs/overview/url-shortener-system-design.md` | Complete system design rationale |
| `docs/notes/API_CONTRACT.md` | Locked per-endpoint request/response shapes |
| `docs/notes/ERROR_CONTRACT.md` | Error envelope format and status code mapping |
| `docs/notes/DECISIONS.md` | 10 locked technical decisions (302 redirects, soft-delete, 404-not-403) |
| `docs/notes/SYSTEM_FLOWS.md` | Mermaid diagrams for all data flows |
| `docs/notes/url-shortener-project-structure.md` | Monorepo layout and module responsibilities |

---

## API Reference

### Authentication Routes

- `POST /api/auth/register` — Register new user
- `POST /api/auth/login` — Authenticate and receive tokens
- `POST /api/auth/refresh` — Refresh access token
- `POST /api/auth/logout` — Revoke refresh token
- `DELETE /api/auth/account` — Anonymize account + soft-delete owned URLs (auth + password required)

### URL Management Routes

- `POST /api/urls` — Create shortened URL (auth required)
- `GET /api/urls` — List user's URLs with pagination (auth required)
- `GET /api/urls/:shortCode` — Get URL details (auth required, ownership enforced)
- `PATCH /api/urls/:shortCode` — Update URL (auth required)
- `DELETE /api/urls/:shortCode` — Soft delete URL (auth required)

### Redirect Route

- `GET /:shortCode` — 302 redirect to original URL (public, no auth)

### Analytics Routes

- `GET /api/analytics/:shortCode` — Aggregated click analytics (auth required)
- `GET /api/analytics/:shortCode/events` — Raw click events (auth required)

### Health Check

- `GET /health` — Server status (no auth)

Full API contract: `docs/notes/API_CONTRACT.md`

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| API Server | Fastify 5 (Node.js / TypeScript) |
| Database | PostgreSQL 15 (partitioned `click_events`) |
| Cache & Queue | Valkey 7 (Redis-compatible) + BullMQ |
| ORM | Prisma 7 with `@prisma/adapter-pg` |
| Frontend | Next.js 15 (App Router, React Server Components) |
| Auth | JWT (access) + Argon2id-hashed refresh tokens (stored in DB) |
| Validation | Zod 4 |
| Logging | Pino / pino-pretty |
| Infrastructure | Docker Compose · Nginx · PM2 |

---

## License

MIT
