# Linkly — Web Client

The Next.js dashboard for **Linkly**, a URL shortener with first-class click
analytics. It renders the public landing page, the auth flow, and the
authenticated dashboard (link management + per-link analytics), and talks
**only** to the Fastify `api` service.

> Part of the URL-shortener repo. The backend lives in [`../server`](../server).
> This client is a **standalone** Next.js app — there is no workspace or root
> `package.json`.

## Prerequisites

- **Node.js 20.9+** (Node 22 LTS recommended) and npm.
- The backend **`api` service running on `http://localhost:3000`** — the browser
  calls it directly. See [`../server`](../server) to start it (Postgres + Valkey
  via `docker-compose`, then the `api` service). For real redirect/click
  analytics data, also run the `redirect` service and the `worker`.

## Getting started

From the repo root (`D:\URL-shortner`):

```bash
npm --prefix client install
npm --prefix client run dev
```

Then open **http://localhost:3002**.

> ⚠️ **The client must run on port 3002.** The API's CORS allow-list only permits
> `http://localhost:3002`; any other origin will fail auth and API calls.
> `npm run dev` already passes `-p 3002`.

(You can also `cd client` and run the scripts without the `--prefix client`
prefix.)

## Environment

The only environment variable is the API origin, and its default is baked into
`src/lib/config.ts`, so the app runs without any `.env` file when the backend is
on `localhost:3000`. To override it, copy `.env.example` to `.env.local`:

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:3000` | Origin the browser calls. Must be in the API's CORS allow-list. |

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Dev server (Turbopack) on **:3002** |
| `npm run build` | Production build |
| `npm run start` | Serve the production build on **:3002** |
| `npm run lint` | ESLint (flat config) |
| `npm run type-check` | `tsc --noEmit` |

Run any of these from the repo root as `npm --prefix client run <script>`.

## Architecture (short version)

- **App Router + RSC.** The landing page (`/`) and auth pages (`login`,
  `register`) are server components (so they export `metadata`); the dashboard
  pages are client components (they rely on hooks/state). Client pages set their
  tab title via the `useDocumentTitle` hook.
- **Auth = in-memory access token + silent refresh.** The 15-minute access token
  lives in memory (never `localStorage`); the refresh token is an httpOnly cookie
  bound to the API. `AuthProvider` runs a single-flight silent refresh on load
  and after a `401`, so a page reload keeps you signed in (one `/auth/refresh`
  call). The browser talks to the API directly with `credentials: "include"`.
- **Server state via TanStack Query.** Components call hooks → `lib/api/*` → the
  typed `apiFetch` client (`lib/api-client.ts`), which unwraps the
  `{ success, message, data }` success envelope, maps errors to `ApiError`
  (`status`, `field`, `retryAfter`, `isRateLimited`), and handles `401` →
  refresh-and-retry. No raw `fetch` in components.
- **Types are derived from the backend contract**, never hand-written — see
  `lib/api-types.ts` and [`../docs/notes/API_CONTRACT.md`](../docs/notes/API_CONTRACT.md).
- **One design-token system.** Every color/radius/font token lives in
  `app/globals.css` (Indigo/Violet brand + a hand-tuned dark theme). Components
  are built on shadcn/ui primitives (the `radix-nova` style) and use tokens —
  never raw hex. Light/dark is handled by `next-themes`.

## Project structure

```
src/
  app/         routes: landing (/), (auth)/*, (dashboard)/* + globals.css
  components/  ui (shadcn) · layout · auth · common · urls · dashboard · analytics · marketing
  lib/         config · api client + endpoint fns · types · validation · formatters · query keys
  hooks/       TanStack Query hooks + useDocumentTitle
  providers/   theme · query · auth providers
```

See `client/CLAUDE.md` and the root `docs/` (contracts, decisions, system design)
for the full API contract and project conventions.
