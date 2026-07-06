---
name: api-integration
description: Use in full-stack / root sessions when connecting the frontend to the backend API — wiring up an endpoint, generating or updating the typed API client, deriving response/request types, or handling the error envelope, auth headers, rate-limiting (429 / Retry-After), or caching/redirect behavior. Derives the client from the locked contracts AND the real server implementation so the frontend consumes the API exactly as built.
---

# API Integration (server → client)

Bridge the backend to the frontend in **root (full-stack) sessions**. The frontend must
consume the API *exactly* as the backend serves it — so derive everything from two sources of
truth: the locked contracts and the actual server code.

## When to use

Wiring a frontend feature to a backend endpoint, generating/updating the typed API client,
defining response/request types, or implementing auth / error / rate-limit / cache handling on
the client.

> This skill lives at the repo root and is active in **root-rooted** sessions, not
> `client/`-rooted ones. Do integration work from the repo root so you can read `server/`.

## Authority — read before writing client code

1. `docs/notes/API_CONTRACT.md` — per-endpoint method, path, request body, response shape, status codes.
2. `docs/notes/ERROR_CONTRACT.md` — the `{ error, details?, retryAfter? }` envelope + status table.
3. `docs/notes/DECISIONS.md` — decisions that change client behavior (e.g. #1 302 redirects, #7 404-not-403).

Then confirm against the **real implementation** — the contract is locked, but verify nothing drifted:

- `server/api/src/routes/*` + `server/api/src/schemas/*` — request validation, response shape, status codes, headers.
- `server/redirect/src/routes/*` — redirect status (302) + cache headers.
- Watch for: `Set-Cookie` (httpOnly refresh token), `Authorization: Bearer`, `WWW-Authenticate`,
  `X-RateLimit-*`, `Retry-After`, `Cache-Control`.

## Process

1. **Scope** — identify the endpoint(s) the feature needs; read the contract entry + the matching server route/schema.
2. **Types** — derive TS request/response interfaces from the response shape. Match field names
   and nullability exactly (e.g. `expiresAt: string | null`). Do not invent fields.
3. **Client call** — implement/extend the typed fetch wrapper:
   - Attach `Authorization: Bearer <accessToken>`; send the refresh cookie where required.
   - On `401` + `WWW-Authenticate`, run the refresh flow, then retry once.
   - Parse every non-2xx as the error envelope; surface `error` (and `details` for 400s).
   - On `429`, respect `Retry-After` / `X-RateLimit-Reset` before retrying.
   - For redirects (`302`), don't follow transparently if the UI needs the target URL.
4. **Verify** — the client's expectations match the server: status codes, exact body shape,
   headers, and the decisions that affect UX (404 vs 403; 410 for expired/deleted URLs).

## Output

Typed API client code + types that mirror the contract and the server, with error / auth /
rate-limit / cache handling. If the contract and the implementation disagree, the **locked
contract wins** — report the discrepancy rather than silently coding to the server.
