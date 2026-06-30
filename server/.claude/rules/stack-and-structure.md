# Stack, structure & commands

Reference material — consult when you need it. The mandatory behavioural rules live in
`non-negotiables.md`, `file-placement.md`, and `invocations.md` (all imported into CLAUDE.md).

## Stack

- **Runtime**: Node.js + TypeScript (ESM, `tsx`), Fastify
- **Database**: PostgreSQL + Prisma ORM
- **Cache / Queue**: Valkey (Redis-compatible) + BullMQ
- **Auth**: JWT (15-min access token) + httpOnly refresh cookie (30-day)
- **Tests**: Vitest (ESM-native)
- **Frontend**: Next.js App Router (separate)

## Source code layout

Three long-running services + a shared package, under `server/`:

```
server/
├── api/        # Fastify API server (:3000) — shorten, auth, list/delete routes
├── redirect/   # Fastify redirect server (:3001) — GET /:shortCode → 302, Swagger /docs
├── worker/     # BullMQ worker — analytics, aggregation, expiry jobs
└── shared/     # shared config, logger, queue, shutdown, rate-limit helpers
```

Each service follows: `routes/` (thin handlers, zero try-catch) → `repositories/*.repository.ts`
(all Prisma calls) → `plugins/` (db, cache, auth, security, swagger) → `middleware/` → `utils/`.

## Commands

```bash
# From a service dir (api, redirect, worker)
npm run dev          # tsx watch
npm run build        # tsc
npm run type-check   # tsc --noEmit

# Prisma (from api)
npx prisma migrate dev      # apply + regenerate after schema change
npx prisma generate         # regenerate client only
npx prisma studio           # browse data
```
