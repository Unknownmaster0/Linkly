# CLAUDE.md — URL Shortener (monorepo root)

Whole-project guidance. This file auto-loads in **every** session (root, `server/`, or
`client/`) because Claude Code walks up the directory tree. Package-specific rules live in
`server/CLAUDE.md` and `client/CLAUDE.md` and load on top of this one.

@.claude/rules/monorepo-conventions.md

---

## What this is

A URL shortener built as an npm-workspaces monorepo:

- **`server/`** — three TypeScript/Fastify services + a shared package:
  - `api` (:3000) — shorten, auth, list/delete, analytics
  - `redirect` (:3001) — `GET /:shortCode` → 302 (hot path)
  - `worker` — BullMQ jobs (analytics, expiry, aggregation)
  - `shared` — config, logger, queue, shutdown, rate-limit helpers
- **`client/`** — Next.js App Router dashboard, talks only to `api`. *(scaffolding stage)*
- **Data** — PostgreSQL (Prisma) + Valkey (cache + BullMQ queues).

Backend is implemented through Day 16; the frontend is just starting.

---

## How to open a session (rooting model)

Claude Code inherits `CLAUDE.md` + agents **upward**, but NOT skills / commands / settings /
hooks. Open the session where the work is:

| Task | Open at | What you get |
|---|---|---|
| Full-stack / wire the client to the API | **repo root** (`d:\URL-shortner`) | this file + the `/api-integration` skill + full read access to `server/` |
| Pixel-perfect frontend | **`client/`** | `client/CLAUDE.md` + frontend config; inherits this file |
| Backend (routes, services, contracts) | **`server/`** | `server/CLAUDE.md` + the locked-contract skills/agents/hook; inherits this file |

---

## Canonical docs (single source of truth — root `docs/`)

Cross-cutting specs live at the root so frontend and backend share one contract:

| Doc | What |
|---|---|
| `docs/notes/API_CONTRACT.md` | Locked per-endpoint request/response shapes + status codes |
| `docs/notes/ERROR_CONTRACT.md` | Error envelope `{ error, details?, retryAfter? }` + status table |
| `docs/notes/DECISIONS.md` | 10 locked technical decisions (302, soft-delete, 404-not-403, …) |
| `docs/notes/SYSTEM_FLOWS.md` | Data flows (create, redirect, analytics, auth) |
| `docs/notes/url-shortener-project-structure.md` | Monorepo layout + module responsibilities |
| `docs/overview/url-shortener-system-design.md` | System design rationale |
| `docs/sections/` | Section-by-section design breakdown |

Backend-only docs (Prisma errors, exception strategy, db, dev-logs, postman) stay under
`server/docs/`.

---

## Integration workflow (root sessions)

When connecting the frontend to the backend, trust the contract **and** the code:

1. Read `docs/notes/API_CONTRACT.md` + `docs/notes/ERROR_CONTRACT.md` for the endpoint.
2. Read the real implementation in `server/api/src/routes` + `schemas` (and
   `server/redirect/src/routes` for redirects) to confirm exact response shape, headers,
   status codes, rate-limit headers, and cache behavior.
3. Use the **`/api-integration`** skill to generate/verify the client's typed request/response
   models, error handling, auth headers, 429 / `Retry-After` handling, and cache awareness.

Never hand-write frontend response types from memory — derive them from the contract + server.
