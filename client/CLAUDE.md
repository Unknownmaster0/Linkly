# CLAUDE.md — client (frontend)

Next.js App Router dashboard for the URL shortener. Talks **only** to the `api` server
(:3000) — never to the redirect server or the database directly. The monorepo-root
`CLAUDE.md` (whole-project overview, rooting model, canonical docs) auto-loads above this file.

## Stack

- Next.js (App Router) + TypeScript (ESM).
- Talks to `api` via a typed fetch client (access token + refresh-cookie flow).
- Specific UI libraries (component kit, charts, data-fetching) are chosen when the app is scaffolded.

## The API contract is the source of truth

Request/response shapes, status codes, and the error envelope are locked in the root docs —
read them before calling an endpoint:

- `../docs/notes/API_CONTRACT.md` — endpoints, request/response shapes, status codes
- `../docs/notes/ERROR_CONTRACT.md` — `{ error, details?, retryAfter? }` envelope
- `../docs/notes/DECISIONS.md` — client-affecting decisions (404-not-403, 302 redirects, 410 gone)

For wiring endpoints to the UI, prefer a **root-rooted session** and the `/api-integration`
skill (it cross-checks the contract against the real server code). Frontend-only, pixel-perfect
work belongs in this `client/`-rooted session.

## Frontend conventions

- **Pixel-perfect** — match the design spec exactly: spacing, type scale, color tokens, and all
  states (hover / focus / active / disabled, plus empty / loading / error).
- **Accessibility** — semantic HTML, keyboard navigation, visible focus, labelled controls, AA contrast.
- **Reuse** — compose from shared UI primitives; don't duplicate component logic. Co-locate a
  component with its styles and tests.
- **Types** — never hand-write API response types from memory; derive them from the contract
  (see `/api-integration`).
- **Data** — keep server state in a data-fetching layer; don't scatter raw `fetch` calls through components.

> Frontend-specific skills / agents / commands will be added under `client/.claude/` once the
> app is scaffolded. For now, this file plus the root config are the guidance.
