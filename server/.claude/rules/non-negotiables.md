# Non-negotiable rules

Read this before implementing **any** endpoint, route handler, or error-handling code.
These rules are non-negotiable and must be followed without exception.

## Error envelope — ALL 4xx and 5xx responses

```json
{ "error": "string", "details"?: {}, "retryAfter"?: number }
```

`error` is always present. `details` only on 400s (field-level context). `retryAfter` only on 429s.
Stack traces and Prisma messages **never** appear in responses.

## The rules

1. **Ownership mismatch → 404, NEVER 403** — returning 403 tells an attacker the resource exists (IDOR)
2. **Route handlers → zero try-catch** for business logic or DB calls — errors bubble to the global handler
3. **Redirect analytics → fire-and-forget** — click event enqueued async, never awaited in the hot path
4. **Soft-delete only** — set `is_deleted = true`; never `DELETE` a URL row (analytics history must survive)
5. **302 for redirects, not 301** — 301 gets browser-cached and breaks per-click analytics
6. **Reserved aliases** — `api`, `health`, `docs`, `admin`, `static` → reject with 400
7. **All Prisma calls → repository layer** — route handlers never call `app.prisma` directly; all DB access goes through a `*.repository.ts` file in `repositories/`

Full contracts: `../docs/notes/API_CONTRACT.md`, `../docs/notes/ERROR_CONTRACT.md`, `docs/notes/exception-handling-strategy.md`
