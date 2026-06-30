# Frontend Build — Handoff & Progress (`client/`)

> **Purpose of this doc:** a self-contained handoff so any future Claude Code session
> (Opus or Sonnet) can resume the URL-shortener **frontend** with the exact intent,
> conventions, and remaining specs. Read §0 → §4 once, then execute §7.

- **Project:** URL shortener. Backend (Fastify `api` :3000, `redirect` :3001, BullMQ
  `worker`) is complete; we are building the Next.js **`client/`** dashboard.
- **Repo is NOT a workspace monorepo** — `client/` is a **standalone** Next.js app that
  happens to live in the same root as `server/`. There is no root `package.json`.
- **Approved plan (full original):** `C:\Users\sagar.kumar\.claude\plans\agile-sleeping-pie.md`.
- **Status (this doc):** Tasks **1–11 complete**, Task **12 pending** (only the live smoke test remains).

---

## 0. How to use this document

1. Run all client commands from the repo root using `--prefix`/`-c` (the shell CWD is
   `D:\URL-shortner`, and we avoid `cd`):
   - `npm --prefix client run type-check`
   - `npm --prefix client run lint`
   - `npm --prefix client run dev` (serves on **:3002**)
   - shadcn: `npx --yes shadcn@latest add -c "D:\URL-shortner\client" -y <name>`
2. Before writing a component, **open the shadcn primitive you'll use** in
   `client/src/components/ui/` and match its real API (this fork — `radix-nova` — differs
   from upstream shadcn; see §4.3).
3. Keep the **look consistent**: Indigo/Violet brand, minimalist, the design tokens in
   `globals.css`, the shared header/footer. Don't introduce new color literals — use tokens.
4. After each task, run type-check + lint and fix to zero before moving on.

---

## 1. What we're building (intent + audience)

A modern, **minimalist** dashboard (not overloaded), with a **nice subtle texture**, a
**consistent header & footer** on every page, and **modular** components. Target users:
**software engineers, engineering students, software professors, business teams** — so the
copy is clear and credible, the analytics are first-class, and the landing page explains the
value quickly with a visual "how it works" flow.

Product name **"Linkly"**, tagline **"Shorten. Share. Measure."** (in `lib/config.ts`).

**Every backend endpoint is integrated.** Pages: public landing (`/`), `login`, `register`,
`dashboard`, `links`, `analytics/[code]`.

---

## 2. Architecture & key backend facts (VERIFIED against real server code)

| Fact | Detail | Consequence for the client |
|---|---|---|
| Base URL | `http://localhost:3000` | `NEXT_PUBLIC_API_BASE_URL` (default baked in `lib/config.ts`) |
| **Client port** | CORS allow-list = `http://localhost:3002` only | **Client MUST run on :3002** (scripts already set `-p 3002`) |
| CORS | `credentials: true`, headers `Content-Type, Authorization`; **no `exposedHeaders`** | Browser **cannot read** `Retry-After`/`X-RateLimit-*` headers → read `retryAfter` from the **error body** |
| Auth | access token (15m) in JSON; refresh token in **httpOnly cookie** bound to :3000 | Browser calls :3000 **directly**; token in memory + **silent refresh** via cookie (`credentials:"include"`) |
| Success envelope | `{ success, message, data }` | `apiFetch` unwraps and returns `data` |
| Error envelope | `{ error, details?, retryAfter? }` | mapped to `ApiError {status, message, details, retryAfter}` |
| Concurrency | access-token verify is stateless (`jwt.verify`, no DB); refresh = 3 indexed ops, no argon2; `PrismaPg` pool | in-memory + silent-refresh is safe; pool size / PgBouncer is deploy-only tuning (not done) |

**Endpoints (exact `data` shapes are in `lib/api-types.ts`):**

| Method | Path | Auth | `data` type |
|---|---|---|---|
| POST | `/api/auth/register` | – | `AuthData` `{user:{id,email}, accessToken}` (+ cookie) |
| POST | `/api/auth/login` | – | `AuthData` |
| POST | `/api/auth/refresh` | cookie | `AuthData` |
| POST | `/api/auth/logout` | Bearer | 204 (void) |
| POST | `/api/urls` | Bearer + ratelimit | `ShortenResult` |
| GET | `/api/urls` | Bearer | `{ urls: UrlListItem[], total }` |
| DELETE | `/api/urls/:shortCode` | Bearer | 204 (void) |
| GET | `/api/analytics/:shortCode` | Bearer | `AnalyticsSummary` |
| GET | `/api/analytics/:shortCode/events?limit=&offset=` | Bearer | `AnalyticsEventsResult` |
| GET | `/health` | – | `HealthStatus` (flat, NOT enveloped — `lib/api/health.ts` handles this) |

**Known contract⇄implementation drifts (client codes defensively; surface in final summary, do NOT "fix" the backend):**
1. Rate limit: contract says 100/hour, real server is **10 per 60s** → client reads `retryAfter`
   from the 429 body, so it's agnostic.
2. Every created URL **gets an expiry** (server applies default 7 days when `ttlDays` omitted) —
   there is **no "never expires"** option. The create form offers 1/7/30/90/365 days.
3. `GET /api/analytics/:shortCode/events` exists in the server but not in the contract doc —
   we integrate it (events table).
4. `404` for both "not found" and "not owned" (IDOR protection) — analytics/delete must treat
   404 as "not found or not yours".

---

## 3. Tech stack & versions (as actually installed)

- **Next.js 16.2.9** (App Router, RSC, Turbopack dev), **React 19.2.4**, **TypeScript 5** (strict
  + `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`).
- **Tailwind CSS v4** (CSS-first `@theme`, `@tailwindcss/postcss`), **ESLint 9** flat config.
- **shadcn/ui** style **`radix-nova`** (base = `radix`, preset = `nova`), `components.json`
  baseColor `neutral`, icon lib `lucide`. Imports the unified **`radix-ui`** package + a
  `shadcn` base CSS package (`@import "shadcn/tailwind.css"` in globals.css).
- **@tanstack/react-query ^5**, **react-hook-form ^7** + **@hookform/resolvers ^5** + **zod ^4**,
  **recharts ^3**, **sonner ^2**, **next-themes ^0.4**, **lucide-react ^1**.
- Font: **Geist** / **Geist Mono** via `next/font`, exposed as `--font-sans` / `--font-mono`
  (root `layout.tsx`) — `globals.css` `@theme` maps these.

> ⚠️ **recharts v3** (not v2). The shadcn `chart.tsx` here is written for v3. Don't downgrade.

---

## 4. Conventions (follow these to stay consistent)

### 4.1 Folder structure (`client/src/`)
```
app/
  layout.tsx               root: <Providers> + <SiteHeader/> + <main> + <SiteFooter/>
  page.tsx                 marketing landing page (RSC, composes components/marketing/*)
  not-found.tsx            branded 404 (RSC, lives inside the global header/footer shell)
  globals.css              the ONE stylesheet / design-token system
  (auth)/layout.tsx        centered, textured frame
  (auth)/login/page.tsx    (auth)/register/page.tsx          server components (read searchParams)
  (dashboard)/layout.tsx   <AuthGuard> + max-w-6xl container
  (dashboard)/dashboard/page.tsx     (dashboard)/links/page.tsx     client pages
  (dashboard)/analytics/[code]/page.tsx   per-link analytics (client)
components/
  ui/        shadcn primitives (do not restyle ad hoc)
  layout/    logo, site-header, site-footer, main-nav, user-menu, theme-toggle
  auth/      auth-guard, login-form, register-form, password-input, form-error
  common/    page-header, copy-button, empty-state, error-state, full-page-loader, stat-card
  urls/      create-url-form, create-url-dialog, url-table, delete-url-dialog
  dashboard/ overview-stats
  analytics/ bar-list, daily-clicks-chart, referrers-card, countries-card, events-table
  marketing/ section-heading, hero, how-it-works, feature-grid, audience, cta
lib/
  config.ts api-types.ts api-client.ts validation.ts format.ts query-keys.ts utils.ts(cn)
  api/ auth.ts urls.ts analytics.ts health.ts
hooks/
  use-urls, use-create-url, use-delete-url, use-analytics, use-analytics-events, use-document-title
providers/
  providers.tsx (composer) theme-provider query-provider auth-provider
```
Naming: kebab-case files, `*.tsx` for components, `use-*.ts` hooks. Imports use the `@/*` alias.

### 4.2 Styling — the single token system (`app/globals.css`)
- All color/radius/font tokens live here as CSS vars in `:root` (light) + `.dark` (hand-tuned,
  NOT inverted: deep indigo-slate surfaces, soft off-white text, vivid-but-legible primary,
  toned-down texture). `@theme inline` maps them to utilities (`bg-primary`, `text-success`,
  `fill-chart-2`, …). **Use tokens, never raw hex** in components.
- Semantic tokens: `success`, `warning`, `info`, `destructive` (+ `-foreground`). Charts:
  `--chart-1..5` (indigo→violet→cyan→fuchsia→amber).
- Reusable texture/util classes (already defined): `bg-grid`, `bg-grid-fade`, `brand-glow`,
  `text-gradient-brand`, `surface-gradient`, `animate-in-up`.
- Badge has **no `success` variant** → use `variant="outline"` + `className="border-success/30 bg-success/10 text-success"` (see `url-table.tsx`).

### 4.3 shadcn `radix-nova` specifics (IMPORTANT — differs from upstream)
- Primitives import from the **unified `radix-ui`** package and use `.Root` etc:
  `import { Slot } from "radix-ui"` then `Slot.Root`; `import { Dialog as DialogPrimitive } from "radix-ui"`.
- **`form` is NOT in the registry** — it was created manually at `components/ui/form.tsx`
  (standard shadcn Form built on RHF + `radix-ui` Slot/Label). Reuse it; don't re-add.
- Button `size`: `default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`; `variant`:
  `default | outline | secondary | ghost | destructive | link`. `destructive` is **subtle**
  (`bg-destructive/10 text-destructive`) by design.
- `DropdownMenuItem` supports `variant="destructive"`; `Avatar` takes a `size` prop
  (`default|sm|lg`), not a size className; `Card` parts include `CardAction`.
- React 19 ref-as-prop: spreading RHF `{...field}` onto `<Input>` wires the ref (no `forwardRef`).

### 4.4 API integration (`lib/`)
- **`apiFetch<T>(path, { method, body, auth, signal })`** (in `api-client.ts`): adds Bearer +
  `credentials:"include"` + `cache:"no-store"`, unwraps the success envelope → returns `data`
  (or `undefined` for 204). On **401** (when `auth!==false`) it runs **single-flight
  `performSilentRefresh()`** and retries once; on terminal failure it clears the token and
  fires `onUnauthorized` (→ AuthProvider redirects to `/login`). Throws **`ApiError`** on
  non-2xx (`.field` helper for 400 `details.field`; `.isRateLimited`; `.retryAfter`).
- Endpoint fns live in `lib/api/*` and are the only callers of `apiFetch`. Components call
  **hooks**, hooks call endpoint fns. Login/register use `auth:false` (a 401 = bad creds, not a
  refresh trigger).
- **Never** hand-write response types — they're in `lib/api-types.ts`, derived from the server
  schemas (`server/api/src/schemas/*`).

### 4.5 Auth
- `AuthProvider` (memory token via `setAccessToken`, single-flight silent refresh on mount,
  `useAuth()` → `{ user, status: "loading"|"authenticated"|"unauthenticated", login, register, logout }`).
- Protected routes are wrapped by `AuthGuard` (in `(dashboard)/layout.tsx`): shows
  `FullPageLoader` until status resolves, redirects to `/login?next=…` when unauthenticated.
- The header shows a skeleton while `status==="loading"`, then user menu vs sign-in buttons.

### 4.6 Data fetching
- **TanStack Query** for all server state. Keys in `lib/query-keys.ts`. Default query options
  (in `query-provider.tsx`): `staleTime 30s`, **no retry on 4xx**, `refetchOnWindowFocus:false`.
  Mutations invalidate `queryKeys.urls`. Never scatter raw `fetch` in components.

### 4.7 Forms
- `react-hook-form` + `zodResolver` with schemas in `lib/validation.ts` (mirror backend rules).
  Use the shadcn `Form/FormField/FormItem/FormLabel/FormControl/FormMessage`. Map field-scoped
  `ApiError` (`error.field`) to `form.setError`; show non-field errors via `<FormError>`; 429 →
  message with `retryAfter`. Submit buttons disable + show `Loader2` while `isSubmitting`.

### 4.8 Component conventions
- Every list/async surface has **loading (Skeleton) / empty (`EmptyState`) / error
  (`ErrorState` + retry)** states. Use `<PageHeader>` for page titles + actions, `<StatCard>`
  for metrics, `<CopyButton>` for copy.
- `"use client"` only where hooks/interactivity are needed; landing/marketing + auth pages stay
  server components (so they can export `metadata`). **Client pages can't export `metadata`**, so
  the dashboard/links/analytics pages set their tab title via the `useDocumentTitle` hook.
- Accessibility: semantic HTML, labelled controls, visible focus, AA contrast, `aria-label` on
  icon-only buttons.

---

## 5. Status board

| # | Task | Status |
|---|---|---|
| 1 | Scaffold Next.js into `client/` (port 3002, strict TS) | ✅ done |
| 2 | Install deps + `shadcn init` + add primitives (+ manual `form.tsx`) | ✅ done |
| 3 | `globals.css` design-token system (Indigo/Violet + hand-tuned dark + texture) | ✅ done |
| 4 | `lib/` integration layer + hooks | ✅ done |
| 5 | Providers + root layout + header/footer | ✅ done |
| 6 | Auth pages, forms, guard | ✅ done |
| 7 | Dashboard overview page | ✅ done |
| 8 | Links management page (table, create dialog, delete confirm) | ✅ done |
| 9 | **Per-link analytics page** | ✅ done |
| 10 | Marketing landing page + `not-found` (and REPLACE scaffold `app/page.tsx`) | ✅ done |
| 11 | Polish: `.env.example`, README, metadata, responsive + a11y pass | ✅ done |
| 12 | Verify: `type-check` + `lint` (0 errors), optional `build` | ⬜ pending |

> `type-check` + `lint` + `next build` are **green through Task 11** (`/`, `/_not-found`,
> `/dashboard`, `/links`, `/register` prerender static; `/analytics/[code]` + `/login` are
> dynamic). Task 12's remaining piece is the **live smoke test** against a running backend.

---

## 6. Files created so far (inventory)

- **Config:** `package.json` (scripts `-p 3002`, `type-check`), `tsconfig.json` (strict+),
  `components.json` (radix-nova), default `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`.
  Removed scaffold `AGENTS.md` + nested `.git`. Preserved `client/CLAUDE.md`, `client/.claude/`.
- **Styling:** `src/app/globals.css`.
- **shadcn ui:** button, input, label, card, dialog, alert-dialog, dropdown-menu, table, badge,
  skeleton, tabs, avatar, tooltip, select, separator, sonner, chart, **form (manual)**.
- **lib:** config, api-types, api-client, validation, format, query-keys, utils; `api/{auth,urls,analytics,health}`.
- **hooks:** use-urls, use-create-url, use-delete-url, use-analytics, use-analytics-events, use-document-title.
- **providers:** providers, theme-provider, query-provider, auth-provider.
- **components/layout:** logo, theme-toggle, site-header, site-footer, main-nav, user-menu.
- **components/auth:** password-input, auth-guard, login-form, register-form, form-error.
- **components/common:** full-page-loader, copy-button, page-header, empty-state, error-state, stat-card.
- **components/urls:** create-url-form, create-url-dialog, url-table, delete-url-dialog.
- **components/dashboard:** overview-stats.
- **components/analytics:** bar-list (shared proportional-bar list), daily-clicks-chart, referrers-card, countries-card, events-table.
- **components/marketing:** section-heading (shared eyebrow+title+desc), hero (+ ShortenPreview), how-it-works (4-step flow), feature-grid, audience, cta.
- **app routes:** root `layout.tsx`; landing `page.tsx` + `not-found.tsx`; `(auth)/layout`, `(auth)/login`,
  `(auth)/register`; `(dashboard)/layout`, `(dashboard)/dashboard`, `(dashboard)/links`,
  `(dashboard)/analytics/[code]`.
- **Polish (Task 11):** `client/README.md` (real README, replaced the scaffold), `client/.env.example`,
  `hooks/use-document-title.ts`; landing `#features` / `#how-it-works` anchors added (+ `scroll-mt`)
  so the header nav links resolve.

---

## 7. Remaining work — detailed specs

### TASK 9 — Per-link analytics page  🟡 (do this first)

**Goal:** `/(dashboard)/analytics/[code]` shows a summary, a clicks-over-time chart, top
referrers, countries, and a paginated raw-events table — for the URL the user owns. Integrates
`GET /api/analytics/:shortCode` (summary) and `GET /api/analytics/:shortCode/events` (events).
Hooks already exist: `useAnalyticsSummary(code)`, `useAnalyticsEvents(code, limit, offset)`.

**Files to create:**

1. `components/analytics/daily-clicks-chart.tsx` (client) — Recharts **AreaChart** via shadcn
   `ChartContainer`. `dailyBreakdown` comes **DESC**; reverse to ASC for the x-axis.
   ```tsx
   "use client";
   import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
   import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
   import type { DailyBreakdownItem } from "@/lib/api-types";

   const config = { clicks: { label: "Clicks", color: "var(--chart-1)" } } satisfies ChartConfig;
   // ChartStyle injects `--color-clicks` from config.clicks.color → use var(--color-clicks).
   export function DailyClicksChart({ data }: { data: DailyBreakdownItem[] }) {
     const series = [...data].reverse();
     if (series.length === 0) return <p className="py-12 text-center text-sm text-muted-foreground">No clicks yet.</p>;
     return (
       <ChartContainer config={config} className="aspect-[16/6] w-full">
         <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
           <defs><linearGradient id="fillClicks" x1="0" y1="0" x2="0" y2="1">
             <stop offset="5%" stopColor="var(--color-clicks)" stopOpacity={0.4} />
             <stop offset="95%" stopColor="var(--color-clicks)" stopOpacity={0.05} />
           </linearGradient></defs>
           <CartesianGrid vertical={false} />
           <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24}
                  tickFormatter={(v: string) => new Date(v).toLocaleDateString("en-US",{month:"short",day:"numeric"})} />
           <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
           <ChartTooltip content={<ChartTooltipContent />} />
           <Area dataKey="clicks" type="monotone" stroke="var(--color-clicks)" fill="url(#fillClicks)" strokeWidth={2} />
         </AreaChart>
       </ChartContainer>
     );
   }
   ```

2. `components/analytics/referrers-card.tsx` — `topReferrers: {referrer, clicks}[]`. A simple
   **list with proportional bars** (compute `max = Math.max(...clicks)`; each row a label +
   `clicks` + a `bg-primary/15` bar at `width: (clicks/max)*100%`). `"direct"` label →
   "Direct". Empty → muted "No referrer data yet."

3. `components/analytics/countries-card.tsx` — `countries: {countryCode, countryName, clicks}[]`.
   Same bar-list pattern; show `countryName` (fallback `countryCode`). Optional: emoji flag from
   `countryCode` via regional-indicator chars. Empty state likewise.

4. `components/analytics/events-table.tsx` (client) — paginated raw clicks. Props `{ shortCode }`;
   own `offset` state (`limit = 10`). Use `useAnalyticsEvents(shortCode, limit, offset)`. Columns:
   When (`formatDateTime(clickedAt)` or relative), Country (`countryCode`/`—`), Device
   (`deviceType`), Browser, OS, Referrer (`referrerDomain`/"Direct"). Prev/Next buttons using
   `total/limit/offset` (hook already keeps previous data via `keepPreviousData`). Loading →
   skeleton rows; empty → `EmptyState`.

5. `app/(dashboard)/analytics/[code]/page.tsx` (client) — **Next 16 dynamic param**: read with
   `useParams<{ code: string }>()` (client page; do NOT `await` params). Compose:
   - `useAnalyticsSummary(code)`.
   - **404 handling:** if `error instanceof ApiError && error.status === 404` → render an
     `EmptyState` (icon `LinkIcon`/`SearchX`) "Link not found" "This short link doesn't exist or
     isn't yours." with a button back to `/links`. Other errors → `ErrorState` + retry.
   - Loading → skeletons.
   - Layout when loaded (`summary` = `AnalyticsSummary`):
     - `PageHeader` title `/{code}` (+ back link to `/links`); a small header line with the
       destination (`prettyUrl(summary.originalUrl)` linking out), `formatDate(createdAt)`,
       `expiryLabel(expiresAt)` + a `CopyButton` for the short URL (build it as
       `${API_BASE_URL}/${code}` OR — cleaner — match the list item's `shortUrl`; summary has no
       `shortUrl`, so either reuse `API_BASE_URL` from `lib/config` or pull the list item. Using
       `${API_BASE_URL}/${code}` is acceptable).
     - 3 `StatCard`s: Total clicks (`totalClicks`), Last 7 days (`last7Days`), Last 30 days (`last30Days`).
     - `DailyClicksChart` (full width card).
     - Two-column `grid lg:grid-cols-2`: `ReferrersCard` + `CountriesCard`.
     - `EventsTable shortCode={code}` (full width card).

**Acceptance:** type-checks; visiting an owned code shows real data; a foreign/missing code shows
the "not found" empty state (never an error/crash); chart renders with brand colors in light+dark.

---

### TASK 10 — Marketing landing page + `not-found`

**Replace** the scaffold `app/page.tsx` (it still renders the Next welcome screen). It's a public
**server component** (RSC) — keep it static and fast. Build modular sections in
`components/marketing/`:

- `hero.tsx` — big headline (use `.text-gradient-brand` on a key word), subcopy aimed at the
  audience, primary CTA `Get started` → `/register`, secondary `Sign in` → `/login`. Background:
  `.bg-grid-fade` + `.brand-glow` layers (subtle). Optionally a mock "shorten" input visual
  (non-functional or links to register).
- `how-it-works.tsx` — a visual **flow**: Paste URL → Get short link → Share → Track clicks.
  Build it as an **inline SVG / flex diagram** (4 steps with icons + connectors); responsive
  (horizontal on `md+`, vertical stack on mobile). This is the "diagram/graph" the user asked for.
- `feature-grid.tsx` — 3–6 feature cards (Custom aliases, Expiry/TTL, Click analytics, Geo &
  referrer breakdown, Fast 302 redirects, Secure auth). Use `Card` + lucide icons.
- `audience.tsx` — short blurbs for engineers / students / professors / business teams.
- `cta.tsx` — closing call-to-action band (gradient/`surface-gradient`) → `/register`.

`app/page.tsx` composes these in `<section>`s with generous spacing (`max-w-6xl` container).
Export `metadata` (title/description). It must look good in light + dark.

Also create **`app/not-found.tsx`** (server component): centered, branded "404 — page not found"
with a link home. Keep within the global header/footer shell.

---

### TASK 11 — Polish

1. **`client/.env.example`** (create):
   ```
   # The Fastify API origin the browser calls directly. Must match the API's CORS allow-list.
   NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
   # NOTE: run the client on port 3002 (npm run dev already sets -p 3002) — the API only
   # allows http://localhost:3002 as a CORS origin.
   ```
2. **`client/README.md`** — what the app is, prerequisites (Node 22+, backend running on :3000),
   `npm install` then `npm run dev` (→ http://localhost:3002), env var, scripts, and a short
   architecture note (memory token + silent refresh, TanStack Query, shadcn tokens).
3. **Page titles for client (dashboard) pages:** client components can't `export const metadata`.
   Either (a) accept the default template title `… · Linkly` (fine), or (b) add a tiny
   `useDocumentTitle(title)` effect hook and call it in dashboard/links/analytics pages. Pick (a)
   unless precise titles are wanted.
4. **Responsive + a11y sweep:** verify header/nav on mobile (center nav is `hidden md:flex`;
   dashboard nav is reachable via the user menu — OK), tables scroll on small screens, dialogs
   are usable, focus rings visible, icon-only buttons have `aria-label`, color contrast AA in both
   themes. Fix anything off.
5. Confirm the **landing/auth render fine when logged-out** and the **silent refresh** keeps a
   session across reload (one `/auth/refresh` in the Network tab).

---

### TASK 12 — Verify

Run and drive to **zero errors** (fix everything; do not suppress):
```
npm --prefix client run type-check     # tsc --noEmit
npm --prefix client run lint           # eslint
npm --prefix client run build          # optional but recommended (Next production build)
```
Then a manual smoke test with the backend up (see §10): register → dashboard → create a link
(custom alias + ttl) → copy/open → see it in `/links` → open `/analytics/[code]` (summary +
chart + referrers + countries + events) → delete (confirm) → reload (session persists) → logout;
exceed the create limit to see the **429** toast/message.

---

## 8. Gotchas / pitfalls

- **shadcn CLI is interactive** about the preset — always pass `-c "<client path>" -b radix -p nova -y`
  (and `-f` to overwrite). `-y` alone does NOT skip the preset prompt.
- **Don't read response headers** for rate-limit/`Retry-After` (CORS hides them) — use the body's
  `retryAfter`.
- **Next 16 dynamic params** are async. In **client** pages use `useParams()`; in **server** pages
  `const { x } = await params/searchParams` (see `(auth)/login/page.tsx`).
- **`metadata` only in server components.** Dashboard pages are client → no per-page metadata.
- **recharts v3** — keep it; the shadcn `chart.tsx` targets v3 (uses `TooltipValueType`,
  `initialDimension`).
- Tailwind v4 supports fractional spacing (`size-4.5`); colors come only from the tokens in
  `globals.css`.
- Keep `client/CLAUDE.md` + `client/.claude/` intact (don't delete).
- No backend changes. If something seems to need one, propose + get approval first (the user's rule).

---

## 9. Acceptance criteria (definition of done for the whole frontend)

- `type-check`, `lint` clean; `build` succeeds.
- Every endpoint in §2 is exercised by the UI.
- Consistent header + footer on all routes; Indigo/Violet brand; genuine light/dark.
- All async surfaces have loading/empty/error states; forms validate inline and map server errors.
- Landing page explains the product with a visual how-it-works flow; auth + dashboard + links +
  analytics all work end-to-end on **:3002** against the API on **:3000**.

---

## 10. Run instructions (for verification)

1. **Infra + backend** (separate terminals, from `server/…`): Postgres + Valkey (e.g.
   `docker-compose up` at repo root), then `npm run dev` in `server/api` (→ :3000). For real click
   data also run `server/redirect` (:3001) + `server/worker`.
2. **Client:** `npm --prefix client install` (if needed) then `npm --prefix client run dev`
   → open **http://localhost:3002** (must be 3002 for CORS).
3. The browser calls the API at `http://localhost:3000` directly with `credentials:"include"`.
