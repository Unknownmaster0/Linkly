# Expert Execution Plan — URL Shortener + Analytics
> **Audience:** Experienced engineer. Familiar with JS, REST, auth, SQL.
> **Pace:** 1–2 hrs/day | **Duration:** 4 weeks | **Stack:** Fastify · PostgreSQL · Valkey · BullMQ · Next.js (App Router)
> **Approach:** Spec-driven. Write the contract first, then the implementation. AI tools are used for decision auditing and spec review — not code generation.

---

## How to Use This Plan

Each day has three layers:

- **Build task** — the concrete thing to produce
- **Design decision** — a trade-off you must make consciously and document
- **AI usage** — how to leverage Claude Code / Claude.ai for thinking, not typing

The guiding rule: **if you can't explain the decision to an interviewer, you haven't made it yet.**

---

## PRE-WORK — Before Day 1 (One time, ~1 hr)

**Read the system design doc in full.** Specifically internalize:
- The 100:1 read/write asymmetry and what it means for your architecture
- The 301 vs 302 trade-off and why analytics forces your hand
- The async analytics pipeline rationale
- The cache invalidation strategy table

Then **write a one-page DECISIONS.md** with these sections (fill it as you go):

```markdown
# Design Decisions

| Decision | Option Chosen | Rejected Option | Reason |
|----------|--------------|-----------------|--------|
| Redirect status code | 302 | 301 | Analytics require server-side visibility |
| Short code generation | Base62(counter + offset) | UUIDv4 | ... |
| Analytics pipeline | BullMQ async queue | Sync DB write | ... |
| Cache strategy | Cache-aside | Write-through | ... |
| JWT strategy | Short-lived + refresh token | Long-lived JWT | ... |
```

**This document is the spec.** Every major decision goes here before you write code. Use Claude.ai to challenge your reasoning — not to generate the table for you.

---

## WEEK 1 — Foundation: Infrastructure, Schema, Core Algorithm

**Weekly goal:** Postgres running, schema migrated, base62 working, Fastify server wired. Every piece of the foundation understood, not copy-pasted.

---

### Day 1 — Environment + Docker + Project Structure

**Build task:**
- Init the Node project with ESM (`"type": "module"`)
- `docker-compose.yml` with postgres:15 + valkey:7
- `.env` with DATABASE_URL, VALKEY_URL, JWT_SECRET, BASE_URL
- Prisma init (`npx prisma init`)
- Verify: `docker ps` shows both containers Up

**Design decision:**
Before creating a single folder, define your directory structure and justify it. Experienced engineers don't scaffold arbitrarily. Decide: will this be a monorepo or two separate repos? Where does the queue worker live — same process as the server or a separate entry point? Document in DECISIONS.md.

**Suggested structure to evaluate:**
```
url-shortener/
  src/
    app.js            # Fastify instance factory
    server.js         # Entry point — starts HTTP listener
    plugins/          # Fastify plugins (cache, db)
    routes/           # Route handlers
    middleware/       # preHandler hooks (auth, ratelimit)
    queues/           # Queue producers
    workers/          # Queue consumers
    utils/            # Pure functions (base62, etc.)
  prisma/
  frontend/           # Next.js app (App Router)
```

**AI usage:** Ask Claude Code to review your directory structure against Fastify's plugin encapsulation model. Ask: "Does this structure allow me to cleanly register plugins before routes?" Not: "Create the folder structure for me."

---

### Day 2 — Prisma Schema + Migration

**Build task:**
- Define `User`, `Url`, `Click` models in `schema.prisma`
- Run `npx prisma migrate dev --name init`
- Verify in Prisma Studio: all tables with correct columns + foreign keys

**Design decision:**
Examine the schema closely before applying it. Two questions to answer in DECISIONS.md:

1. The `Url.id` is a `cuid()`. Why not a sequential integer? (Answer: Base62 encoding works off a counter, but the *row ID* doesn't have to be the counter source — understand the difference between the record's PK and the short code generation strategy.)

2. The `Click` table stores raw events. At scale (billions of rows), this becomes unusable for analytics without pre-aggregation. Decide now: will you implement a `DailyAnalyticsAggregate` table as part of MVP, or defer it? Document the trade-off.

**Bonus depth:** Read how Prisma handles BigInt. The base62 algorithm uses `BigInt` — understand why JS numbers aren't sufficient for very large IDs at Bitly scale.

**AI usage:** Paste your schema into Claude.ai and ask: "What indexes am I missing? What query patterns does this schema fail to support efficiently?" Evaluate the suggestions — don't blindly apply them.

---

### Day 3 — Base62 Algorithm

**Build task:**
- Implement `encode(BigInt)` and `decode(string)` in `src/utils/base62.js` from scratch
- Write your own test assertions (no test framework needed — plain `assert`)
- Verify: `encode(62n) === '10'`, `decode(encode(999999n)) === 999999n`

**Design decision:**
Understand *why* the algorithm uses `BigInt` before you type a character. The connection: PostgreSQL `BIGSERIAL` can produce IDs exceeding `Number.MAX_SAFE_INTEGER` (2^53 − 1). At Bitly scale (100M URLs/day), you could exhaust safe integer range in ~90,000 years — so why bother with BigInt now? Because production code is written for correctness at all scales, not convenience at current scale.

Also decide: the novice plan uses `url.count()` as the counter source. This is a race condition waiting to happen under concurrent inserts. Research the alternatives:
- PostgreSQL `SEQUENCE` (atomic counter)
- Counter row with `SELECT ... FOR UPDATE`
- Application-level counter in Valkey

Document your chosen approach and why in DECISIONS.md.

**AI usage:** After implementing, ask Claude.ai: "What are the collision risks with this approach under concurrent writes?" Use the response to stress-test your counter strategy decision.

---

### Day 4 — Fastify App Skeleton + Health Route

**Build task:**
- `src/app.js` — `buildApp()` factory function (not a singleton — testability matters)
- `src/server.js` — imports `buildApp()`, calls `listen()`
- `GET /health` — queries DB (`SELECT 1`), returns `{status, db, timestamp}`
- Verify: `curl localhost:3000/health` returns 200

**Design decision:**
Understand why `buildApp()` is a *factory function* that returns a new app instance, rather than exporting a singleton app. This is Fastify's recommended pattern — it allows test suites to spin up isolated instances without port conflicts. If you've only used Express, this pattern may feel unfamiliar.

Also: configure Pino logging correctly from day one. `pino-pretty` for dev, raw JSON for production. The `NODE_ENV` check belongs here, not scattered across the codebase.

**AI usage:** Ask Claude Code: "Review this Fastify app factory for any anti-patterns that would affect testability or plugin encapsulation." Use it as a code reviewer, not a code generator.

---

### Day 5 — Auth Routes: Register + Login

**Build task:**
- `npm install @fastify/jwt bcryptjs`
- `src/routes/auth.js` — `POST /api/auth/register` and `POST /api/auth/login`
- Register `@fastify/jwt` plugin with `JWT_SECRET` from env
- Fastify JSON Schema validation on register body (email format, password minLength)
- Verify: register returns JWT, login with wrong password returns 401

**Design decision:**
The novice plan uses a single JWT with 1-hour expiry. An experienced engineer knows this is a security liability — a stolen JWT is valid for an hour with no revocation path.

Implement proper token pair strategy:
- **Access token:** 15-minute expiry, stateless, signed with `JWT_SECRET`
- **Refresh token:** 30-day expiry, stored as a hashed value in a `RefreshToken` DB table (so it can be revoked), returned in an `httpOnly` cookie

Add a `RefreshToken` model to your Prisma schema now (or document that you're deferring it and why).

Document the JWT vs. Session decision in DECISIONS.md: "JWT was chosen because the API is stateless and may serve mobile clients. Refresh tokens are stored server-side to enable revocation — pure stateless JWT with no revocation is unacceptable for a user-facing product."

**AI usage:** Ask Claude.ai: "What are the OWASP guidelines for JWT storage and rotation?" Evaluate whether your implementation satisfies them. Produce a short gap analysis.

---

### Day 6 — Auth Middleware + Shorten Route

**Build task:**
- `src/middleware/authenticate.js` — Fastify `preHandler` that calls `request.jwtVerify()`
- `src/plugins/cache.js` — Valkey client as a Fastify plugin (`app.decorate('cache', client)`)
- `src/routes/shorten.js` — `POST /api/shorten` with `preHandler: [authenticate]`
- Fastify schema validation on body (url format:uri, optional customAlias, optional ttlDays)
- Short code generation (using your Base62 + chosen counter strategy)
- Write to DB, write to Valkey cache with TTL
- Verify: authenticated POST returns `shortUrl`. Check Prisma Studio + Valkey CLI

**Design decision:**
The cache write on URL creation is a write-through pattern. But the system design doc recommends cache-aside (write only on first cache miss). Revisit this decision:

- **Write-through on create:** The URL is immediately cached. Pros: first redirect is always a cache hit. Cons: you cache URLs that may never be accessed (wasted memory).
- **Cache-aside:** Cache only on first redirect. Pros: memory efficiency, only hot URLs are cached. Cons: first redirect is always a DB hit.

Which is right for a URL shortener? Document your answer in DECISIONS.md.

**AI usage:** Ask Claude.ai to review your Fastify plugin implementation of the cache: "Does this plugin follow Fastify's encapsulation model correctly? Will `app.cache` be available to all routes?" This is the kind of subtle bug that causes production issues.

---

### Day 7 — Week 1 Review + Spec Audit

**Build task:**
- Review every file written this week — refactor for consistency
- Ensure all routes use the same error response shape: `{ error: string, details?: any }`
- Push clean commit to GitHub
- Update DECISIONS.md with any decisions made implicitly this week

**Design decision review:**
Before leaving Week 1, answer these out loud (without looking at notes):
1. Why is `buildApp()` a factory, not a singleton?
2. What's the difference between the URL's database PK and the short code counter source?
3. Why does `encode()` take a `BigInt`?
4. What's the trade-off between cache-aside and write-through?

If you can't answer any of these, don't move to Week 2 until you can.

**AI usage:** Paste your DECISIONS.md into Claude.ai and ask: "What decisions am I missing that a senior engineer would have documented at this stage?" Treat the response as a checklist, not gospel.

---

## WEEK 2 — Core System: Redirect Pipeline, Click Tracking, Rate Limiting

**Weekly goal:** The full read path working end-to-end. Click events processed asynchronously. Rate limiting protecting the write path. Every decision documented.

---

### Day 8 — BullMQ Queue Setup + Click Worker

**Build task:**
- `npm install bullmq`
- `src/queues/clickQueue.js` — Queue producer (`click-events` queue)
- `src/workers/clickWorker.js` — Worker that consumes jobs and inserts Click rows
- Wire worker startup into `src/server.js`
- Test: manually enqueue a job, verify Click row appears in DB within ~1 second

**Design decision:**
Two architectural choices to make before writing code:

1. **Same process or separate process?** Running the BullMQ worker in the same Node process as the HTTP server is simpler but means a worker crash can affect the HTTP server (and vice versa). Separate processes are more resilient but add deployment complexity. For this project, same-process is acceptable — but document why and what you'd change at scale.

2. **Job retry strategy:** BullMQ supports exponential backoff on failure. Set `attempts: 3` with `backoff: { type: 'exponential', delay: 1000 }`. Understand what happens to jobs that fail all 3 attempts (they land in the failed set). What's your strategy for the failed queue? Log + alert? Reprocess manually? Document it.

**AI usage:** Ask Claude.ai: "In a BullMQ setup where the worker and HTTP server share the same process, what failure modes exist? How would I separate them?" Use this to inform your DECISIONS.md entry.

---

### Day 9 — Redirect Route (The Critical Path)

**Build task:**
- `src/routes/redirect.js` — `GET /:shortCode`
- Cache lookup → DB fallback → cache population → queue click event → 302 redirect
- Cache miss path: check URL expiry, return 410 for expired URLs
- The `clickQueue.add()` must NOT be awaited — fire and forget with `.catch()`
- Verify: browser follows redirect. Pino logs show MISS then HIT on second access.

**Design decision:**
Look at this line in the novice plan:
```javascript
const urlRecord = await app.prisma.url.findUnique({ where: { shortCode }, select: { id: true } })
```
This is a *second* DB query on the cache miss path — after you've already fetched the full URL record for the redirect. That's 2 DB round-trips on every cache miss. Fix it: fetch the full record once, extract both `originalUrl` and `id`, use both.

Also notice: on a cache *hit*, the code still hits the DB to get `urlRecord.id` for the click event. This partially defeats the cache. How do you fix it? One approach: store both the `originalUrl` and `urlId` in the Valkey value as a JSON object. Evaluate the trade-offs and document your solution.

**AI usage:** Ask Claude Code to review your redirect handler specifically for: "Any unnecessary DB queries? Any places where I'm awaiting something that should be fire-and-forget?" Use it as a performance reviewer.

---

### Day 10 — Rate Limiter (Token Bucket in Valkey)

**Build task:**
- `src/middleware/rateLimiter.js` — Token Bucket algorithm using Valkey as shared state
- Add to `POST /api/shorten` preHandler chain: `[authenticate, rateLimiter]`
- Return `X-RateLimit-Remaining` header on every response
- Return 429 with `Retry-After` header on exhaustion
- Verify: 11th rapid request returns 429

**Design decision:**
The novice plan implements token bucket with a single `GET` + logic + `SET` in Valkey. This is a race condition — two concurrent requests can both read `tokens: 1`, both decide it's OK, and both proceed, effectively allowing 2 requests through on 1 token.

The correct implementation uses Valkey's atomic operations. Research the options:
- **Lua script** (atomic multi-step operation in Valkey)
- **WATCH + MULTI/EXEC** (optimistic locking transaction)

Implement using a Lua script. This is the production-correct approach and is interview-worthy. Document the race condition and your solution in DECISIONS.md.

**AI usage:** After writing the Lua script, ask Claude.ai: "Does this Lua script have any atomicity gaps? Does it handle the race condition correctly?" Then verify the reasoning yourself.

---

### Day 11 — Analytics Route

**Build task:**
- `src/routes/analytics.js` — `GET /api/analytics/:shortCode` (auth required)
- Ownership check: `url.userId !== req.user.userId` → 404 (not 403 — explain why)
- Aggregate queries: total clicks, last-7-days clicks, top referrers, daily breakdown
- Verify: after generating test clicks, analytics returns real data

**Design decision:**
The ownership check returns 404, not 403. This is an intentional security decision called **information leakage prevention**: returning 403 tells the attacker "this URL exists but you don't own it." Returning 404 reveals nothing. Document this in DECISIONS.md — it's exactly the kind of decision interviewers probe.

Also: the `dailyClicks` query uses `$queryRaw`. Understand why Prisma's ORM layer can't express `GROUP BY DATE(column)` without raw SQL. This is a real ORM limitation — knowing where to reach for raw SQL is an experienced engineer skill.

**AI usage:** Ask Claude.ai: "What are the performance characteristics of this analytics query at 1 million click rows? What would you add?" Use the response to decide whether to implement pre-aggregation now or defer it.

---

### Day 12 — Valkey Plugin + Graceful Shutdown

**Build task:**
- Ensure `src/plugins/cache.js` uses `fastify-plugin` wrapper (so decorations leak out of plugin scope)
- Add `onClose` hook: disconnect Valkey cleanly
- Add graceful shutdown to `src/server.js`: listen for `SIGTERM`, call `app.close()`
- Verify: `kill -TERM <pid>` causes clean shutdown (no hanging connections)

**Design decision:**
Graceful shutdown is not optional in production — Kubernetes sends `SIGTERM` before terminating pods, and any in-flight requests that get cut off cause errors for users. Your server must:
1. Stop accepting new connections
2. Finish processing in-flight requests
3. Drain the DB connection pool
4. Exit

Understand what Fastify's `app.close()` does and does not do for you. Does it drain the BullMQ worker? If not, how do you handle that?

Document the shutdown sequence in DECISIONS.md. This is one of the questions in the system design doc's interview section.

**AI usage:** Ask Claude Code to review your shutdown sequence: "Does this shutdown handler ensure all in-flight requests complete before exit? Does it close the BullMQ worker cleanly?"

---

### Day 13 — List URLs Route + Global Error Handler

**Build task:**
- `GET /api/urls` (auth required) — user's URLs with click counts via Prisma `_count`
- Global error handler in `app.js`: handle Prisma `P2002` (unique constraint) → 409, validation errors → 400, everything else → 500
- Verify: duplicate custom alias returns 409, not a 500

**Design decision:**
Understand Prisma error codes. `P2002` is a unique constraint violation — the custom alias already exists. Rather than catching this in route-level try/catch, the global error handler intercepts it. This is cleaner but requires you to understand what error shapes Prisma throws at different failure modes.

Also: the error handler is the right place to scrub sensitive information from 500 responses. In development, you want the full stack trace. In production, you never want internal details leaked. Implement the `NODE_ENV` check here.

**AI usage:** Ask Claude.ai: "What other Prisma error codes should I handle in a production global error handler for a URL shortener?" Map the result to your actual error handling strategy.

---

### Day 14 — Week 2 Review + E2E Test Script

**Build task:**
- Write `test.sh` that exercises the full flow: register → shorten → redirect → analytics
- Run it clean (against a fresh DB state if possible)
- Update DECISIONS.md with any gaps

**Spec audit:**
Before moving to frontend, verify your backend spec is complete:
- Every route has a documented request/response shape
- Every error case has a documented status code and reason
- The DECISIONS.md table has an entry for every significant trade-off

The spec IS the documentation. If it's incomplete, your README will be vague.

**AI usage:** Paste your complete route list and expected responses into Claude.ai and ask: "What edge cases am I not handling? What error states would a QA engineer try first?" Use the gaps to write explicit test cases in `test.sh`.

---

## WEEK 3 — Next.js Frontend + Deployment

**Weekly goal:** A real dashboard, not just a proof-of-concept. Backend deployed and accessible. Architecture diagram complete.

---

### Day 15 — Next.js App Setup (App Router)

**Build task:**
- `npx create-next-app@latest frontend --app --typescript` (TypeScript is non-negotiable for a portfolio project)
- Structure: `app/` with `login/page.tsx`, `dashboard/page.tsx`, `analytics/[shortCode]/page.tsx`
- `lib/api.ts` — Axios instance with `Authorization` header interceptor
- JWT stored in `httpOnly` cookie, NOT `localStorage` — implement this correctly from day one

**Design decision:**
The novice plan stores JWT in `localStorage`. This is an XSS vulnerability. An experienced engineer knows this and uses `httpOnly` cookies for token storage.

However, this creates a complication for the Next.js App Router: server components can read cookies, but client components cannot read `httpOnly` cookies via `document.cookie`. Research Next.js's `cookies()` API for server components and how to structure your auth flow accordingly.

Document in DECISIONS.md: "JWT stored in httpOnly cookie to prevent XSS. Implication: client-side JS cannot read the token directly; all authenticated requests must go through Next.js Server Actions or API routes that have cookie access."

**AI usage:** Ask Claude.ai: "In Next.js App Router, what's the correct pattern for reading an httpOnly auth cookie in a server component vs. a client component? How do Server Actions fit in?" Understand the pattern before implementing it.

---

### Day 16 — Dashboard Page + URL Shortening Form

**Build task:**
- Dashboard: fetches `GET /api/urls` (server-side, using the auth cookie), renders URL list table with click counts
- Shorten form: client component, `POST /api/shorten`, refreshes the list on success
- Handle loading states and error states explicitly — no silent failures
- Verify: log in, create a URL, see it appear in the list with 0 clicks

**Design decision:**
With Next.js App Router, you have a choice for the URL list fetch:
- **Server Component + `fetch()`** (data fetches at request time, no client-side waterfall)
- **Client Component + `useEffect()`** (the SPA pattern — data fetches after hydration)

For a dashboard that needs fresh data, Server Components with `cache: 'no-store'` are correct. But the shorten form needs to be a Client Component (it has interactivity). Understand the Server/Client boundary and how to compose them. Document your approach.

**AI usage:** Ask Claude.ai: "What are the data fetching patterns in Next.js App Router for a dashboard that needs real-time data? When should I use Server Components vs. Client Components?" Then implement based on your understanding of the answer.

---

### Day 17 — Analytics Chart Page

**Build task:**
- `app/analytics/[shortCode]/page.tsx` — server component fetches analytics, passes to client chart component
- Install `recharts` — render `BarChart` for daily click data
- Country breakdown table if you implemented geo enrichment
- Verify: clicking a URL in the dashboard navigates to its analytics page with real data

**Design decision:**
The chart is a Client Component (recharts requires the DOM). The data fetching is a Server Component. This is the standard composition pattern in App Router. Understand it well enough to explain it: "I fetch data in the Server Component and pass it as props to the Client Component for rendering. This means the page HTML is pre-rendered with data on the server, which is better for SEO and initial load performance."

---

### Day 18 — EC2 Backend Deployment

**Build task:**
- Provision Ubuntu 22.04 t2.micro EC2 (free tier)
- Install Node, PM2
- Clone repo, `npm install`, `npx prisma migrate deploy`
- Set production env vars (use PM2 ecosystem file, not raw `export`)
- Run Valkey on the same instance for now
- Verify: `curl http://<ec2-ip>:3000/health` returns 200 from your local terminal

**Design decision:**
The PM2 ecosystem file (`ecosystem.config.js`) is preferable to raw environment variable exports because it's version-controlled (secrets excluded), reproducible, and PM2 manages restarts automatically.

Also: configure EC2 Security Group to only expose port 3000 (or better, 80 via Nginx reverse proxy). Don't expose PostgreSQL or Valkey ports to the public internet. Document your security group rules.

**AI usage:** Ask Claude.ai: "What are the minimum security hardening steps for a Node.js API running on an EC2 instance? What would a security engineer check first?" Implement the critical ones.

---

### Day 19 — Vercel Frontend Deployment + Connect to EC2

**Build task:**
- Deploy the Next.js app to Vercel (not Netlify — Next.js is Vercel-native, uses edge functions correctly)
- Set `NEXT_PUBLIC_API_URL` environment variable to EC2 backend URL
- Verify: Vercel URL → login → create URL → see dashboard → see analytics

**Design decision:**
The novice plan uses Vite + Netlify. An experienced engineer chooses Vercel for Next.js because Vercel's infrastructure is purpose-built for Next.js features (ISR, Edge Functions, App Router streaming). Document this decision.

Also: configure CORS on your Fastify server to allow requests from the Vercel domain. Don't use `origin: '*'` — use the exact Vercel URL.

---

### Day 20 — README + Architecture Diagram

**Build task:**
- Draw architecture diagram in Excalidraw: User → Nginx/EC2 → Fastify → [PostgreSQL, Valkey, BullMQ Worker]
- README sections: Architecture, Tech Decisions (the 4–6 most important), API reference, Local setup, Live demo links
- The Tech Decisions section pulls directly from DECISIONS.md — this is why you maintained it

**The README is the product.**
A recruiter who can't run your code will read your README. A senior engineer who can run your code will read your README *first*. It must communicate that you made decisions, not followed a tutorial.

**Required content for Tech Decisions section:**
- Why Fastify over Express (schema validation, lifecycle hooks, plugin model)
- Why BullMQ for click logging (async analytics is the core architectural insight)
- Why 302 over 301 (analytics visibility trade-off)
- Why cache-aside (power-law traffic distribution)
- Why the rate limiter is in Valkey, not in-process

---

### Day 21 — Week 3 Review + Live Demo Test

**Build task:**
- Run the full E2E test against the live EC2 + Vercel deployment
- Fix any production-specific bugs (CORS, env vars, Prisma connection pool in serverless context)
- Push final Week 3 state as a tagged release: `git tag v0.3.0`

**Oral exam (do this out loud, no notes):**
1. "Walk me through what happens when someone clicks a short URL — every step, every system involved."
2. "Why did you use BullMQ instead of `await db.insert()` in the redirect handler?"
3. "Your rate limiter has a race condition in the naive implementation — how did you fix it?"
4. "What does graceful shutdown mean and why does it matter in Kubernetes?"

If you hesitate on any of these, the project isn't done.

---

## WEEK 4 — Hardening, Stretch Goals, Interview Prep

**Weekly goal:** The project earns the word "production" in its description. Load tested, documented, defensible in any interview.

---

### Day 22 — IP Geolocation Enrichment in Worker

**Build task:**
- In `clickWorker.js`: call `ip-api.com` (free tier, no key required) to resolve `ipAddress` → `countryCode`
- Geo lookup failure must never fail the job — wrap in try/catch with fallback to `null`
- Update analytics route to include country breakdown with `groupBy(['country'])`
- Add country table to analytics page in Next.js

**Design decision:**
The geo lookup adds latency to the worker — but since the worker is asynchronous, this latency is invisible to the user. The important constraint is that external API failures (network error, rate limit) should not cause the job to fail and be retried, which would cause retries to hammer the geo API. Use a per-job timeout and graceful fallback.

---

### Day 23 — Delete URL + Cache Invalidation

**Build task:**
- `DELETE /api/urls/:shortCode` (auth required, ownership verified)
- Implement soft delete: set `is_deleted = true` (requires schema addition), not hard delete
- After delete: `DEL url:<shortCode>` from Valkey, write a negative entry `DELETED` with 30s TTL
- Verify: deleted URL returns 410 Gone immediately (from negative cache entry), not 404

**Design decision:**
Why soft delete? Hard delete destroys analytics history. If a user deletes a URL that had 10,000 clicks, those analytics rows become orphaned. Soft delete with `is_deleted = true` preserves history while making the URL inactive.

The negative cache entry is equally important: without it, the redirect handler would fall through to the DB on every request for a deleted URL (cache miss → DB lookup → 404). The negative entry tells the cache layer "this code is dead — don't hit the DB." Document both decisions.

---

### Day 24 — Custom Alias Validation + Reserved Words

**Build task:**
- Regex validation: aliases must match `/^[a-zA-Z0-9-]+$/` (alphanumeric + hyphen only)
- Block reserved words at the route level: `['api', 'health', 'docs', 'admin', 'static']`
- Return descriptive 400 errors with the specific validation failure

**Design decision:**
The reserved words list is a security and routing concern. If a user creates a custom alias `api`, their URL would shadow the `/api` prefix route. Think through the routing precedence in your Fastify app and verify that redirect routes registered at `/:shortCode` cannot shadow your API routes.

---

### Day 25–26 — Load Test + Performance Analysis

**Build task:**
- `npm install -g autocannon`
- Test redirect endpoint: `autocannon -c 50 -d 10 http://localhost:3000/<cached-shortCode>`
- Measure: latency p50, p95, p99; requests/sec
- Target: p99 < 20ms on cache hit path
- If p99 > 20ms, profile — is it the DB query on cache hit? Is `clickQueue.add()` blocking?

**Design decision:**
The load test will reveal whether your fire-and-forget queue enqueue is truly non-blocking. A common mistake: accidentally `await`-ing `clickQueue.add()`. The entire point of the async architecture is that the redirect returns immediately — the queue enqueue must be non-blocking.

After the test, document the results in your README:
> "Redirect endpoint: p99 = Xms at 50 concurrent connections. Cache-hit path: ~Xms. Cache-miss path: ~Xms."

Real numbers in a README demonstrate that you measured, not guessed.

**AI usage:** After getting load test results, describe them to Claude.ai: "My p99 is Xms. Here's my redirect handler. What's the likely bottleneck?" Use the analysis to guide your investigation.

---

### Day 27 — Swagger Docs + API Spec Finalization

**Build task:**
- `npm install @fastify/swagger @fastify/swagger-ui`
- Register in `app.js` — it auto-generates docs from your existing JSON Schema definitions
- Visit `/docs` — verify every route has documented request body, response shapes, and auth requirements
- This is your public API contract

**Design decision:**
Fastify's schema-first design means your validation schemas are also your documentation. If a route's schema is incomplete, the docs will be incomplete — and your validation will be incomplete. This is the payoff of writing schemas from day one.

---

### Day 28 — LEARNINGS.md + Final Commit

**Build task:**
- `LEARNINGS.md` in repo root:
  - What was harder than expected and why
  - What would you design differently if starting over (be specific)
  - One thing you'd add with one more week
  - One question about this project you still can't fully answer
- Final push. Tag `v1.0.0`.

**The last design decision:**
Write one paragraph describing this project for a job application or portfolio site. It should not start with "I built a URL shortener." It should start with a decision you made.

> *"The core design challenge was separating the redirect path's latency requirements (sub-10ms p99) from the analytics write requirements (eventual consistency acceptable). I solved this by..."*

If you can write that paragraph without looking at notes, the project is done.

---

## Summary Table

| Week | Focus | End State | Key Decisions |
|------|-------|-----------|---------------|
| 1 | Foundation | DB, auth, base62, Fastify server | Counter strategy, cache write pattern, JWT token model |
| 2 | Core system | Full redirect pipeline, BullMQ, rate limiting | Async analytics, atomic rate limiter, 302 vs 301 |
| 3 | Frontend + Deploy | Next.js dashboard live on Vercel, API on EC2 | App Router data fetching, httpOnly cookies, CORS |
| 4 | Hardening | Load tested, Swagger docs, portfolio-ready | Soft delete, negative cache, load test results documented |

---

## AI Tool Usage Principles

| Tool | Use for | Never use for |
|------|---------|---------------|
| Claude.ai | Decision auditing, trade-off challenges, spec review | Writing implementation code |
| Claude Code | Code review, pattern validation, finding bugs in your code | Generating boilerplate |
| GitHub Copilot (Haiku) | Autocomplete for known patterns (test assertions, SQL) | Architecture decisions |
| ChatGPT | Second opinion on design decisions | Primary reference |

The rule: **AI tools are a rubber duck that talks back.** You explain your decision to it; it challenges you. You either defend your position or update your thinking. The decision remains yours.

---

## Fastify Docs Reference (Read Only When Needed)

| When | Page |
|------|------|
| Plugin model confusion | [Plugins Guide](https://fastify.dev/docs/latest/Guides/Plugins-Guide/) |
| Schema validation | [Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) |
| Lifecycle hooks | [Lifecycle](https://fastify.dev/docs/latest/Reference/Lifecycle/) |
| Decorator API | [Decorators](https://fastify.dev/docs/latest/Reference/Decorators/) |
| Error handling | [Errors Reference](https://fastify.dev/docs/latest/Reference/Errors/) |

Do not read ahead. Read when you have a concrete question.
