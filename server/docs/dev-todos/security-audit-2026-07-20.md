# Security Audit — Adversarial (attacker-mindset) — 2026-07-20

Full findings from an attacker-mindset security sweep of the backend. Unlike
[`todos.md`](./todos.md) (standards-compliance deviations that are *not* bugs), this file
tracks **security findings** — some are functional gaps, some are hardening. Items use
`[SEC-NNN]` ids kept **separate** from the `[TODO-NNN]` sequence so the two trackers don't
collide.

- **Method:** static source audit (no live stack was stood up) across `api`, `redirect`,
  `worker`, `shared`, plus git/filesystem secret checks. Ownership/error/soft-delete/repository
  conventions were treated as intended design and used as the yardstick, not flagged.
- **Attack paths covered:** (1) IDOR/broken object-level authz, (2) auth bypass,
  (3) privilege escalation, (4) rate-limit & feature abuse, (5) injection (SQLi/XSS),
  (6) internal exposure, (7) business-logic manipulation.
- **Source:** `adversarial-security-audit` skill run via the `red-team-auditor` agent, then
  each headline citation re-verified by hand.

## Verdict

**No CRITICAL or HIGH provable breach.** IDOR is correctly closed on every owned-resource
endpoint (owner-scoped queries → 404, never 403), every protected route carries the auth
guard, there is **no role/admin surface at all** (nothing to escalate into), all raw SQL is
parameterized, and **no secrets are committed**. The real gaps are in **data-lifecycle on
account deletion** and a handful of **hardening** items — all MEDIUM or below.

## Priority order (fix data-theft/unauthorized-access before abuse/logic)

| ID | Sev | Path | Finding | Status |
|----|-----|------|---------|--------|
| [SEC-001](#sec-001) | MEDIUM | #7 | Account deletion never evicts the redirect cache — deleted links keep resolving up to the cache TTL | **FIXED — 2026-07-20** |
| [SEC-002](#sec-002) | MEDIUM | #2 | Deleted/deactivated account keeps API access for the access-token lifetime (≤15 min); logout doesn't revoke it | **RESOLVED — 2026-08-04** (DECISIONS.md #18/#19) |
| [SEC-003](#sec-003) | LOW→MED | #6 | Swagger `/docs` (full OpenAPI + UI) served unauthenticated in production | **OPEN** — proposed |
| [SEC-004](#sec-004) | LOW | #4 | Rate limiting fails **open** when Valkey is down — including the login/register brute-force guard | **OPEN** — proposed |
| [SEC-005](#sec-005) | LOW | #2/#7 | Refresh-token rotation has a check-then-revoke race → two live token chains from one cookie | **OPEN** — proposed |
| [SEC-006](#sec-006) | INFO | #4 | Mass-signup surface + email enumeration via distinct `409` on register | **By design** — no action |
| [SEC-007](#sec-007) | LOW | #2 | JWT verification did not pin the signing algorithm | **FIXED — 2026-07-20** |

---

## Open findings

<a id="sec-002"></a>
### [SEC-002] [RESOLVED — 2026-08-04] Deleted/deactivated account keeps API access for the access-token lifetime · MEDIUM · attack path #2

**Files:** `api/src/middleware/auth.ts:12-43` (`authenticate`); `api/src/routes/auth.ts:252-262`
(`logout`).

**Attacker scenario:** `authenticate` verifies the JWT signature and reads `payload.userId`,
but **never loads the user row**, so it never sees `isActive = false`. After User A deletes
their account (which sets `isActive = false`), their still-unexpired access token keeps
authorizing every protected call until `exp`. `POST /api/auth/logout` (auth.ts:252-262)
revokes only the *refresh* token — the access token stays valid until it expires.

**Blast radius:** Low-to-moderate, time-boxed to ≤15 min. A just-deleted user can still call
`POST /api/urls` (creating rows owned by a now-anonymized account) and read analytics of their
own soft-deleted URLs. No cross-tenant access. This is the standard stateless-JWT tradeoff.

**Proof:** auth.ts:12-43 (middleware) contains no repository/DB call — the only source of
truth for identity is the token's own `userId` claim.

**Resolution (2026-08-04):** fixed in two parts, both locked as decisions —
- **DECISIONS.md #18:** on logout and account deletion, every still-live access token's
  `jti` is added to a Valkey **revocation denylist** (TTL = remaining token life).
  `authenticate` checks the denylist (one Valkey `SISMEMBER`/`GET`) before trusting the
  signature. Access dies at next use, not at `exp`.
- **DECISIONS.md #19:** access-token lifetime shortened 15 min → **10 min**, shrinking the
  theft window and every denylist TTL by a third.
- **Fail-open trade-off (accepted, documented in #18):** if Valkey is down, a revoked token
  stays usable until `exp` (≤10 min). The designed-but-deferred `revoked_tokens` DB backstop
  table (Valkey down ⇒ query it instead) is recorded in the plan as a future option.

**Status:** RESOLVED — 2026-08-04. No code yet; implementation ordered behind Q1 in
`plan/hardening-plan.md`.

---

<a id="sec-003"></a>
### [SEC-003] [OPEN — proposed] Swagger `/docs` served unauthenticated in production · LOW→MEDIUM · attack path #6

**Files:** `api/src/plugins/swagger.ts:75-78` and `redirect/src/plugins/swagger.ts:41-44` —
both register `@fastify/swagger-ui` at `/docs` with no `NODE_ENV` gate and no auth.

**Attacker scenario:** Anyone requests `GET /docs` (and `/docs/json`) in production and reads
the entire API surface — every route, params, the auth scheme, rate-limit headers, and the
error envelopes.

**Blast radius:** Reconnaissance-grade, not a breach. It documents only the already-public
contract and leaks no secrets, but it hands an attacker a complete map of the app and
accelerates every other probe.

**Proof:** neither plugin references `config.NODE_ENV` around the `swaggerUi` registration,
even though `config.NODE_ENV` is available (it is already used in the OpenAPI `servers` block,
swagger.ts:48).

**Recommended fix:** wrap the `swaggerUi` registration in
`if (config.NODE_ENV !== 'production') { … }`, or put `/docs` behind basic auth in production.
- **Confirm first:** API_CONTRACT §Docs specifies a `/docs` route — if `/docs` is an
  *intended* public surface, this is working as designed and should instead be noted there.
  That ambiguity is why it's proposed, not applied.

**Status:** OPEN — proposed (pending contract confirmation).

---

<a id="sec-004"></a>
### [SEC-004] [OPEN — proposed] Rate limiting fails open when Valkey is unreachable — including auth brute-force guards · LOW · attack path #4

**Files:** `api/src/plugins/cache.ts:69-77` (returns `{ allowed: true }` on any Valkey error);
`shared/src/rateLimitCheck.ts` (documents the fail-open contract). Auth limiters that depend on
it: `api/src/routes/auth.ts:155-175` (login: per-IP + per-account), register guard.

**Attacker scenario:** If Valkey is down — or an attacker can induce Valkey errors — **all**
limits evaporate at once. That includes the per-IP and per-account **login** guard and the
**register** guard, so unlimited credential-stuffing and mass signup are re-enabled for the
duration of the outage.

**Blast radius:** Conditional on a Valkey outage; while it lasts, brute-force/abuse protection
is absent.

**Proof:** cache.ts:73-76 explicitly `return { allowed: true, … }` inside the `catch`.

**Recommended fix:** This is a deliberate availability-over-strictness tradeoff (documented and
intentional for create/redirect). Consider failing **closed for the auth brute-force limiters
specifically** — a Valkey outage should not open credential stuffing — while keeping fail-open
for create/redirect. This is a per-limiter policy change, hence proposed, not applied.

**Status:** OPEN — proposed.

---

<a id="sec-005"></a>
### [SEC-005] [RESOLVED — 2026-08-04] Refresh-token rotation check-then-revoke race · LOW · attack path #2/#7

**Files:** `api/src/services/auth.service.ts:95-125` (`refresh`); revoke is
`api/src/repositories/auth.repository.ts:60-65` (`updateMany where revokedAt: null`).

**Attacker scenario:** Two concurrent `POST /api/auth/refresh` calls carrying the **same**
cookie both read `revokedAt = null` (auth.service.ts:99-103) before either revokes
(line 108). Because `revokeRefreshToken` is an `updateMany … where revokedAt: null`, exactly
one revoke wins and the other no-ops — **but both requests still proceed to mint a fresh token
pair**, yielding two valid refresh chains from a single original token.

**Blast radius:** Low — requires racing a token you already legitimately hold. The core
security property (a *revoked* token cannot be reused later) still holds; this only duplicates
a chain the holder already controls.

**Proof:** the read at auth.service.ts:99-103 and the revoke at :108 are not atomic; the revoke
returns an affected-row count that is currently ignored before new tokens are issued.

**Resolution (2026-08-04):** locked as **DECISIONS.md #20**. Rotation becomes an
"atomic-revoke-then-issue": `updateMany … where revokedAt: null`; issue a new pair **only when
the affected-row count is exactly 1**. Any concurrent/lost race turns into a full **token-family
revocation** — the *presented* token is already revoked (`count === 0`), so the user is treated
as a token thief and **every** active refresh token for the account is revoked and a forced
re-login. This converts SEC-005's duplicate-chain bug into a theft kill-switch.

**Status:** RESOLVED — 2026-08-04. No code yet; implementation ordered behind Q1 in
`plan/hardening-plan.md`.

---

<a id="sec-006"></a>
### [SEC-006] [BY DESIGN] Mass-signup surface + email enumeration on register · INFO · attack path #4

**Files:** `api/src/config.ts:53-54` (register rate limit: per-IP only, 5/60s);
`api/src/services/auth.service.ts:44-46` (register throws a distinct `409 "Email already
registered"`).

**Notes:** Registration is rate-limited **per-IP only** with no email-verification step, so an
attacker rotating IPs can create usable accounts at scale. And the distinct `409` on a
duplicate email enables **email enumeration**, even though *login* is carefully generic
(dummy-hash + single 401). Both are consistent with the locked API_CONTRACT (the `409` is
documented) and with normal signup UX, so this is **informational, not a defect**. If abuse
ever matters, the feature-scale fix is an email-verification step (propose-first) and/or a
per-fingerprint signup limit.

**Status:** By design — no action unless abuse becomes a concern.

---

## Resolved during this audit

<a id="sec-001"></a>
### [SEC-001] [FIXED — 2026-07-20] Account deletion never evicts the redirect cache · MEDIUM · attack path #7 (data lifecycle)

**Files:**
- `api/src/repositories/auth.repository.ts:76-99` — `deleteAccount` (the transaction)
- `api/src/services/auth.service.ts:140-155` — `deleteAccount`
- `api/src/routes/auth.ts:264-282` — `DELETE /api/auth/account` handler
- Correct pattern mirrored: `api/src/routes/url.ts:169-172` — single-URL delete *does* evict
- Hot path that previously read the stale entry: `redirect/src/routes/redirect.ts:80-91` + TTL at `:124`

**Attacker scenario (the bug, as it existed):**
1. User A owns shortlink `gY1k`. Someone clicks it at least once, so the redirect server
   caches it in Valkey as `url:gY1k` with `{ isDeleted: false, isActive: true, originalUrl }`
   and TTL = `min(remaining, 24h)` (`redirect.ts:124`, `cacheTtl`).
2. User A calls `DELETE /api/auth/account`. The transaction anonymized the user row, set
   `isActive = false`, soft-deleted every URL (`prisma.url.updateMany … isDeleted: true`), and
   hard-deleted refresh tokens. It returned `void` — no short codes surfaced and no cache op
   ran anywhere in the delete flow.
3. The redirect hot path checks the cache **first** (`redirect.ts:80-91`). The cached object
   still said `isDeleted: false`, so the guard didn't trip, and the server kept issuing
   `302 → originalUrl` for up to the remaining TTL (max 24h).

**Blast radius:** "Delete my account" did not actually take the user's links down. A user who
deletes precisely to be forgotten still had working links pointing at their destinations for up
to a day. Only *previously-clicked* (cached) URLs were affected; uncached URLs 410 correctly on
the next DB lookup. No cross-tenant access — this was a data-lifecycle / privacy-promise gap,
not a data breach.

**Proof (pre-fix):** `deleteAccount` (auth.repository.ts, old) ran
`prisma.url.updateMany({ where: { userId, isDeleted:false }, data:{ isDeleted:true } })` and
returned `void`; the handler called it and never touched `app.cache`. Compare
url.ts:171-172, which does `await app.cache.del(record.shortCode)` +
`app.cache.setDeleted(record.shortCode)` after a single delete. The redirect cache-hit branch
never re-reads the DB, so the stale entry was authoritative until TTL.

**Alternative considered — async BullMQ job:** enqueue the shortCodes from the route handler
and evict the cache from a new worker job, instead of inline in the request. Rejected: it still
requires the same repository read (no latency actually saved), and it would have added 5 new
pieces of infrastructure — a new queue + job type in `shared`, a brand-new `api/src/plugins/
queue.ts` (api has no queue producer today), a brand-new Valkey client inside `worker` (the
worker touches zero cache today, not even the expiry job), a new `Worker` registration +
shutdown wiring, and a third duplicate copy of the `url:`/`DELETED:` key-prefix constants. It
also introduces a new silent-failure mode (a lost/stuck job never evicts the cache, with no
current dead-letter alerting to catch it). None of that is justified for an endpoint that runs
once per account, ever, and is deliberately not rate-limited/hot-path already (it does an
argon2 verify + multi-table transaction inline).

**Fix (applied):**
```diff
 // api/src/repositories/auth.repository.ts
-    async deleteAccount(userId: string): Promise<void> {
-      await prisma.$transaction([
+    async deleteAccount(userId: string): Promise<string[]> {
+      const [urlsToEvict] = await prisma.$transaction([
+        prisma.url.findMany({
+          where: { userId, isDeleted: false },
+          select: { shortCode: true },
+        }),
         prisma.user.update({ /* ... unchanged ... */ }),
         prisma.url.updateMany({
           where: { userId, isDeleted: false },
           data: { isDeleted: true },
         }),
         prisma.refreshToken.deleteMany({ where: { userId } }),
       ]);
+
+      return urlsToEvict.map((url) => url.shortCode);
     },
```
```diff
 // api/src/services/auth.service.ts
-    async deleteAccount(userId: string, password: string): Promise<void> {
+    async deleteAccount(userId: string, password: string): Promise<string[]> {
       const user = await repo.findUserById(userId);
       /* ... unchanged password checks ... */
-      await repo.deleteAccount(userId);
+      return repo.deleteAccount(userId);
     },
```
```diff
 // api/src/routes/auth.ts
-    await authService.deleteAccount(request.userId, parsed.data.password);
+    const shortCodes = await authService.deleteAccount(request.userId, parsed.data.password);
+
+    await Promise.all(
+      shortCodes.flatMap((code) => [app.cache.del(code), app.cache.setDeleted(code)])
+    );

     clearRefreshCookie(reply);
     return reply.status(204).send();
```
The `findMany` runs as the first statement inside the same `$transaction` array as the
`updateMany`, so under normal operation it sees the identical row set (same `userId` +
`isDeleted: false` filter) the soft-delete then affects. This isn't a hard snapshot guarantee
under the default Read Committed isolation: a URL the same user creates in the instant between
these two statements would still get soft-deleted but wouldn't appear in the returned list —
harmless here, since a URL that young has never been redirected and so has no positive cache
entry to evict. Eviction runs concurrently
across all owned codes via `Promise.all` rather than a sequential loop, so accounts with many
URLs don't serialize N Valkey round-trips. Both `app.cache.del`/`setDeleted` already swallow
their own errors internally (`cache.ts`), so a Valkey hiccup still can't fail the deletion
response — same guarantee the single-URL delete path already relied on.

**Verified:** `npx tsc --noEmit` in `server/api` passes (exit 0). Traced against
`redirect/src/routes/redirect.ts`: after this fix, a `DELETE /api/auth/account` response is not
sent until every owned shortCode's `url:<code>` entry is deleted and a `DELETED:<code>` (30s
TTL) negative-cache marker is set — identical side effects to the single-URL delete path
(`url.ts:171-172`), just applied per-code across the whole account. `server/api` has no
automated test harness yet (no Vitest config, `"test"` script is a placeholder), so this was
verified by type-checking + code trace, not a live-stack integration test; a follow-up to add
`api` test coverage (via the `unit-test-generator` agent) remains open separately from this fix.

**Docs updated:** `docs/notes/API_CONTRACT.md` (`DELETE /api/auth/account` Side Effects) and
`docs/notes/DECISIONS.md` (Decision 13 addendum) now document the cache-eviction side effect,
matching what Decision 9 already documents for the single-URL delete path.

---

<a id="sec-007"></a>
### [SEC-007] [FIXED — 2026-07-20] Pin JWT verification algorithm · LOW · attack path #2

**File:** `api/src/middleware/auth.ts:25`.

**Issue:** `jwt.verify(token, config.JWT_SECRET)` without an `algorithms` option lets `verify`
honor whatever algorithm the token's own header declares — the classic `alg:none` /
algorithm-confusion forgery class. Not practically exploitable here (jsonwebtoken v9 rejects
`alg:none` by default and the secret is symmetric, so there is no RS→HS confusion path), but
pinning is the correct defense-in-depth and guards a future maintainer who swaps the secret
type.

**Fix (applied):**
```diff
- payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
+ payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
```
`HS256` is exactly what the sign side uses — `signAccessToken` (auth.service.ts:24) calls
`jwt.sign(...)` with no explicit algorithm, so jsonwebtoken's HS256 default applies. Any token
whose header declares a non-HS256 algorithm (including `none`) now hits the `catch` →
`AuthError` → `401`.

**Verified:** `npx tsc --noEmit` in `server/api` passes (exit 0); the sign/verify algorithms
match, so existing logins are unaffected. Change is uncommitted (per policy — commit left to
the maintainer).

---

## Controls that HELD UP (checked, with evidence)

- **IDOR — closed on all four owned-resource endpoints.** Delete scopes by `userId` in one
  transaction and 404s on mismatch (`url.repository.ts:96-118` →
  `OwnershipError`); list filters `{ userId, isDeleted:false }`; analytics summary + events go
  through `requireOwnedUrl` (`analytics.service.ts:24-30`). `OwnershipError` maps to **404,
  never 403** (`errors.ts:41-45`) per the locked anti-enumeration decision.
- **Auth enforced on every protected route** — `POST/GET/DELETE /api/urls`, both analytics
  routes, `logout`, `DELETE /api/auth/account`. Only register/login/refresh/health/redirect are
  public.
- **No privilege-escalation surface** — no `role`/`isAdmin` field in the schema, no admin
  routes, no mass-assignment (`createUser` writes explicit fields; Zod strips unknown keys, so
  a client-sent `plan`/`isActive` is dropped).
- **No SQL injection** — every raw query uses Prisma tagged-template parameterization
  (`analytics.repository.ts`, `url.repository.ts`); the only `$executeRawUnsafe` is a static
  `TRUNCATE` in a test helper.
- **No verbose-error / stack-trace leakage** — both global handlers map the unexpected to a
  generic 500 and log details server-side only; Prisma known-errors are code-mapped;
  `statusCode`/`message` from untrusted errors are never passed through. Health returns a flat
  `{ status, db, timestamp }`.
- **No secrets exposed** — `.env` is gitignored for all three services; `git log --all` shows
  only a placeholder `.env.example` ever committed; `config.ts` requires `JWT_SECRET` /
  `JWT_REFRESH_SECRET` with **no hardcoded fallback**.
- **Password & session hygiene** — argon2id hashing; login runs a dummy hash on unknown/
  inactive users and returns one generic 401 (timing-safe enumeration defense); refresh tokens
  stored as SHA-256 hashes, rotated on use, revocable; logout verifies token ownership before
  revoking; refresh cookie is `HttpOnly; SameSite=Strict` and `Secure` outside development.
- **SSRF / redirect-XSS guard at creation** — URL creation restricts protocol to http/https
  and blocks loopback/link-local/RFC-1918 (`url.schema.ts`), so `javascript:`/`data:` and
  private targets can't be stored; the redirect `Location` can only be a validated external
  http(s) URL.
- **IP-spoof-resistant rate limiting** — `trustProxy: 'loopback'` on both services, so
  `request.ip` comes from nginx's own XFF entry, not an attacker-forged header; login is
  additionally guarded per-account.
- **CORS & headers** — credentialed CORS with an explicit origin allow-list (never `*`); helmet
  CSP `default-src 'self'`, `frame-ancestors 'none'`, HSTS 1y, frameguard DENY.

---

## How to use this file

- IDs are `[SEC-NNN]`, numbered by priority, **separate** from `todos.md`'s `[TODO-NNN]`.
- When a finding is resolved, mark it `[FIXED — <date>]` and add the applied diff + verification
  (see SEC-007 as the template).
- If a finding is intentionally accepted, mark it `[BY DESIGN]` / `[ACCEPTED — <date>]` and
  record the rationale (and mirror it into DECISIONS.md where it changes behavior).
- Re-run the audit with the `red-team-auditor` agent (or the `adversarial-security-audit` skill)
  after auth, roles, uploads, or payment changes.
