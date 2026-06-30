# Monorepo conventions

Cross-cutting rules for the whole `url-shortener` monorepo. Package-specific rules live in
`server/.claude/` and `client/.claude/`.

## Layout

```
d:\URL-shortner\
├── server/   # api, redirect, worker, shared — TypeScript/Fastify backend
├── client/   # Next.js App Router frontend
├── docs/     # canonical, monorepo-wide docs (contracts, decisions, system design)
└── docker-compose.yml
```

Full layout + module responsibilities: `docs/notes/url-shortener-project-structure.md`.

## Where docs live

- **Root `docs/`** — canonical & shared. In `notes/`: `API_CONTRACT`, `ERROR_CONTRACT`,
  `DECISIONS`, `SYSTEM_FLOWS`, `url-shortener-project-structure`, `url-shortener-expert-plan`;
  plus `overview/` (system design) and `sections/` (design breakdown).
- **`server/docs/`** — backend-only: `exception-handling-strategy`, `prisma-errors`, `db/`,
  `dev-log/`, `dev-todos/`, `postman/`.

When referencing a root doc from inside `server/` or `client/`, use `../docs/...`.

## Stack & language

- TypeScript + ESM everywhere (`"type": "module"`, run via `tsx`).
- Backend: Fastify + Prisma (PostgreSQL) + Valkey (cache / BullMQ). Tests: Vitest.
- Frontend: Next.js App Router. (Frontend tooling is authored when that work begins.)

## Claude Code config inheritance (important)

A session rooted in a subfolder inherits from parent folders **only** for:

- `CLAUDE.md` (walks up the tree)
- agents (`.claude/agents/`)

It does **NOT** inherit skills, slash commands, `settings.json`, or hooks across folders.
So shared CLAUDE.md + agents go at the root; package-specific skills / commands / settings /
hooks live in that package's `.claude/`. Open the session where the work is (see root
`CLAUDE.md`).

## Conventions

- File naming follows the structure doc (`*.repository.ts`, `*.service.ts`, `*.job.ts`,
  `*.schema.ts`; route files stay thin).
- Keep a change scoped to one package unless the task is explicitly cross-cutting.
- The contracts in `docs/notes/` are **locked** — code conforms to them, not the reverse.
