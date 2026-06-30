# URL Shortener

A production-grade URL shortening system designed for high throughput and low-latency redirects. Built with a microservices-inspired architecture that separates URL creation from high-volume redirect serving.

## Architecture Overview

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

**Key design choices:**
- `302` redirects (not `301`) so analytics are tracked on every visit
- Cache-aside L1 (in-process LRU) → L2 (Valkey) → L3 (PostgreSQL) for redirect hot paths
- Async analytics via BullMQ — redirect latency is never blocked by DB writes
- Base62-encoded PostgreSQL sequence for short codes (no UUID collisions, enumeration-resistant via shuffle)

## Tech Stack

| Layer | Technology |
|---|---|
| API Server | Fastify 5 (Node.js / TypeScript) |
| Database | PostgreSQL 15 (partitioned `click_events`) |
| Cache & Queue | Valkey 7 (Redis-compatible) + BullMQ |
| ORM | Prisma 7 with `@prisma/adapter-pg` |
| Frontend | Next.js (App Router) |
| Auth | JWT (access) + stored refresh tokens (Argon2 hashed) |
| Validation | Zod |
| Logging | Pino / pino-pretty |
| Infrastructure | Docker Compose · Nginx · PM2 |

## Repository Structure

```
url-shortener/                # monorepo root — docker-compose.yml + (future) client/
└── server/                   # backend root (this README)
    ├── api/                  # Fastify API server (:3000) — see api/README.md
    │   ├── prisma/           # schema + migrations (owns the DB schema)
    │   └── src/              # routes, services, repositories, plugins
    ├── redirect/             # Fastify redirect server (:3001) — GET /:shortCode → 302
    │   └── src/
    ├── worker/               # BullMQ worker — analytics, expiry, aggregation jobs
    │   └── src/jobs/
    ├── shared/               # @url-shortener/shared — config, logger, queue, rate-limit
    │   └── src/
    └── docs/                 # design docs, dev logs, contracts, Postman collections
```

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### 1. Start infrastructure

The compose file lives at the monorepo root (one level up from `server/`):

```bash
docker compose up -d
```

This starts PostgreSQL on `:5432` and Valkey on `:6379`.

### 2. Set up the API server

From `server/`:

```bash
cd api
cp .env.example .env   # fill in values — see api/README.md
npm install
npx prisma migrate dev
npm run dev
```

The API server starts on `http://localhost:3000`.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://admin:secret@localhost:5432/urlshortener` | PostgreSQL connection string |
| `VALKEY_URL` | `redis://localhost:6379` | Valkey/Redis connection string |

> Docker Compose credentials: user `admin`, password `secret`, database `urlshortener`.

## Performance Targets

| Metric | Target |
|---|---|
| Redirect p99 latency | < 10 ms |
| URL creation p95 latency | < 200 ms |
| Analytics query | < 500 ms |
| Redirect throughput | 115,000 req/s |
| URL creation throughput | 1,160 req/s |
| Availability | 99.9% |

## Design Documents

All design decisions are documented in `/docs`:

| Document | Contents |
|---|---|
| `docs/overview/url-shortener-system-design.md` | Complete system design |
| `docs/notes/url-shortener-expert-plan.md` | 4-week execution roadmap |
| `docs/sections/section-3-api-design-hinglish.md` | API contracts |
| `docs/sections/section-4-database-design-hinglish.md` | DB schema & indexes |
| `docs/sections/section-5-system-architecture-hinglish.md` | Architecture breakdown |
| `docs/sections/section-6-url-generation-strategy-hinglish.md` | Base62 / Snowflake ID strategy |
| `docs/sections/section-8-edge-cases-failure-handling-hinglish.md` | Edge cases & failure modes |
| `docs/sections/section-9-performance-optimization-hinglish.md` | Caching, batching, latency |
