# Security Review Handoff — Deserialization/Serialization & SSRF

**Project:** URL Shortener monorepo (`D:\WEB DEV\URL-shortener-resource`)
**Date:** 2026-08-24
**Reviewer session:** AI orchestrator (hy3-free) + two `explore` subagents (deserialization, SSRF), with orchestrator verification of key claims.
**Status:** READ-ONLY review complete. **No code changes were made.** This document hands off the findings + recommended fixes to the next agent.

---

## 1. What this handoff covers
A security review of two concerns requested by the user:
1. **Deserialization / Serialization** — improper handling can lead to RCE, DoS, data tampering.
2. **SSRF** — server-side request forgery via outbound requests to attacker-controlled destinations.

The goal of the session was analysis only ("give the proper analysis before making any changes"). No edits were applied.

## 2. Scope & method
- Two fresh-context `explore` agents ran in parallel: one for deserialization/serialization sinks, one for SSRF sinks (all under `server/`, lightly `client/`).
- The orchestrator then **independently verified** the most actionable claims by reading source and running a Node test, because one subagent finding was wrong (see §5).
- No sensitive data (keys, passwords, PII) was encountered; nothing to redact.

## 3. Key findings — Deserialization / Serialization
- **RCE: NONE.** Repo-wide grep for `eval(`, `new Function`, `vm.`, `child_process`, dynamic `require`/`import(`, YAML/XML parsers, `serialize-javascript`/`superjson`/`node-serialize`/`msgpack`/`v8.serialize` returned **zero matches** in `server/`.
- **JWT: SAFE.** `server/api/src/middleware/auth.ts:29` uses `jwt.verify(token, secret, { algorithms: ['HS256'] })` — algorithm pinned, defeats `alg:none`/key-confusion. Refresh tokens are opaque `randomBytes` + sha256 (no `JSON.parse`).
- **Request bodies: SAFE.** Fastify `JSON.parse` → then Zod validation before use; malformed body → 400. JSON parse is inert (no code execution).
- **F-1 (Tamper, conditional) — `server/redirect/src/plugins/cache.ts:67`.** `JSON.parse` of Valkey `url:<code>`, then `cached.originalUrl` is trusted for the 302 with no re-validation. `JSON.parse` cannot execute code; malformed JSON → cache miss. Exploitable only if attacker has direct Valkey write access. Bounded risk.
- **F-2 (DoS/robustness, minor) — `server/api/src/routes/auth.ts:125`.** `decodeURIComponent(value)` on attacker-controlled cookie with no try/catch → malformed `%` throws → global handler returns 500 instead of 401. Not RCE; process stays up.
- **F-3 (Tamper, low) — `server/worker/src/jobs/analytics.job.ts`.** `job.data` built from raw request headers (`User-Agent`, `Referer`, `ip`). Only string parsing; `new URL(referrer)` in try/catch; geo `fetch` uses `encodeURIComponent(ip)`. `request.ip` non-spoofable (`trustProxy:'loopback'`). No code exec.
- **F-4 (Latent) — `nextCursor` not implemented.** `docs/notes/API_CONTRACT.md` documents base64 `nextCursor` keyset pagination on `GET /api/urls`, but grep confirms it is **not built** (only offset pagination exists on analytics events). When built, it will be the one place a true attacker string gets `base64decode → JSON.parse` — must whitelist keys, re-scope by `userId`, wrap parse. Not exploitable today.

## 4. Key findings — SSRF
- **Server-side SSRF: NONE in current code.** The server never fetches a user-supplied URL. `POST /api/urls` stores `originalUrl`; `GET /:shortCode` returns `reply.redirect(originalUrl, 302)` (`server/redirect/src/routes/redirect.ts:90,129`) — the **visitor's browser** fetches the target, not the server.
- **Only outbound request — `server/worker/src/jobs/analytics.job.ts:81-84`:** `fetch('http://ip-api.com/json/<ip>?fields=status,countryCode')`. Host hardcoded `ip-api.com`; `<ip>` is the non-spoofable visitor IP in the URL **path**; server always connects to `ip-api.com`, never to the IP (so `169.254.169.254` metadata never reached). Not SSRF. Minor separate note: plaintext `http://` geo call is MITM-exposed (transport issue).
- **Real weakness — DNS bypass in `isPrivateOrLocal` (`server/api/src/schemas/url.schema.ts:14-47`).** Guards against `localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, etc. A public domain whose A record resolves to a private IP (e.g. `127.0.0.1.nip.io`, `evil.attacker.com`→`10.x`) **passes** the literal hostname check because the guard never resolves DNS. Impact today = open-redirect/phishing (victim's browser reaches internal/loopback). For an internal/enterprise deployment this is a real internal-phishing vector; for a public deployment it mostly hits the victim's own localhost.

## 5. Verification correction (IMPORTANT — subagent was wrong here)
The SSRF subagent claimed IP-encoding forms bypass `isPrivateOrLocal`: `http://2130706433/`, `http://0x7f000001/`, `http://127.1/`, `http://[0:0:0:0:0:0:0:1]/`. The orchestrator **ran a Node test** and they do NOT bypass it — `new URL()` normalizes them to canonical `127.0.0.1` / `[::1]`, which the guard catches:
```
decimal 2130706433 → 127.0.0.1  (caught)
hex    0x7f000001 → 127.0.0.1   (caught)
short  127.1      → 127.0.0.1   (caught)
ipv6  [0:...:1]   → [::1]       (caught)
```
The **only** genuine bypass is the DNS-resolution one in §4. Do NOT "fix" the IP-encoding cases — they already work. Focus any guard fix on DNS resolution.

## 6. Recommended next steps (not yet done — owner's decision)
1. **SSRF guard (Medium, do first for defense-in-depth):** make `isPrivateOrLocal` resolve the hostname to an IP at validation time (and guard DNS-rebinding), instead of trusting the literal string. Cheap; closes the latent critical-SSRF door if the server ever fetches `originalUrl`.
2. **Valkey cache re-validation (Low):** after `JSON.parse` at `cache.ts:67`, re-validate `originalUrl` is `http(s)` + object shape, so a poisoned cache entry can't hijack a redirect.
3. **Cookie `decodeURIComponent` (Low/robustness):** wrap `auth.ts:125` in try/catch → clean 401/400 instead of 500.
4. **When building `nextCursor`:** validate + whitelist + re-scope by `userId` + wrap parse (see F-4).

## 7. Suggested skills for the next session
The next agent should invoke these via the Skill tool as relevant:
- `ai-coding-workflow` — to run the plan → implement → test pipeline for the 4 fixes above (fresh-context steps, avoids context degradation).
- `code-review` — to review the implemented fixes against the repo's standards + this spec.
- `implement` — if the user wants a spec/ticket-driven implementation of the guard fix.
- `diagnosing-bugs` — only if a fix regresses (e.g., legit URLs blocked by the hardened guard).
- `api-integration` — only relevant if `nextCursor` (F-4) is implemented and the client must consume it.

## 8. References / artifacts (do not duplicate — read these)
- `docs/notes/API_CONTRACT.md` — locked endpoint + `nextCursor` design (F-4 source).
- `server/api/src/schemas/url.schema.ts` & `server/redirect/src/routes/redirect.ts` — verified guard + redirect logic.
- `server/redirect/src/plugins/cache.ts:67` — F-1 cache parse.
- `server/api/src/routes/auth.ts:125` — F-2 cookie decode.
- `server/worker/src/jobs/analytics.job.ts:81-84` — sole outbound fetch (F-3, geo).
- `server/api/src/middleware/auth.ts:29` — JWT verify (SAFE).
- Project conventions: root `AGENTS.md`, `server/CLAUDE.md` (mandatory non-negotiables — note "zero try-catch in route handlers" rule affects fix #3).

## 9. Open questions for the next agent
- Is this deployment public-facing, internal/enterprise, or both? Determines severity of the DNS open-redirect bypass (Medium public / higher internal).
- Will any future feature fetch `originalUrl` server-side (preview/favicon/screenshot)? If yes, the DNS bypass becomes **critical** SSRF — fix #1 becomes urgent.
- Confirm Valkey is not exposed to untrusted networks (affects F-1 severity).
