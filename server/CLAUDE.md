# CLAUDE.md

Guidance for Claude Code in this repository. **Mandatory rules are at the top and the
bottom of this file** — read both. The middle is reference, looked up on demand.

---

## MANDATORY — read before writing any code

These imported rules are non-negotiable and apply to every route, handler, and error path:

@.claude/rules/non-negotiables.md
@.claude/rules/file-placement.md
@.claude/rules/invocations.md

> `invocations.md` (imported above) is the single source of trigger logic — *which* skill or
> agent to invoke on *which* condition, and *which* docs each one enforces. The reference
> section below is only a passive index; the active "when to invoke" rules live there.

---

## Project Status

**Implementation is active.** Completed through **Day 15** — async-job test suite for the
worker crons + UTC→IST analytics bucketing (Day 15), OpenAPI/Swagger docs on both HTTP
servers (Day 13), custom-alias namespace-collision hardening + health-route cleanup
(Day 14). Three services are live: `api` (:3000), `redirect` (:3001),
`worker` (BullMQ). Next: Day 16.

---

## Reference (lazy — opened on demand, NOT auto-loaded)

These are large and deliberately not pulled into context every turn. Open the relevant one
when the task touches it; the skills above already read them when invoked.

- **Stack, source layout, commands** → `.claude/rules/stack-and-structure.md`
- **Agents** (`code-reviewer`, `day-end-audit`, `unit-test-generator`) → `.claude/agents/`

### Key design documents

| Document | Purpose |
|---|---|
| `../docs/notes/API_CONTRACT.md` | Per-endpoint request/response specs (locked) — enforced by `/api-design` |
| `../docs/notes/ERROR_CONTRACT.md` | Error envelope shape + HTTP status table (locked) — enforced by `/error-handling` |
| `docs/notes/exception-handling-strategy.md` | Six-layer architecture, custom error hierarchy — enforced by `/error-handling` |
| `docs/notes/prisma-errors.md` | Prisma error code → HTTP status mapping — enforced by `/error-handling` |
| `../docs/notes/url-shortener-project-structure.md` | Monorepo layout and module responsibilities |
| `../docs/notes/DECISIONS.md` | The 10 locked technical decisions (302, soft-delete, 404-not-403, …) |
| `../docs/notes/url-shortener-expert-plan.md` | 4-week execution plan |

---

## MANDATORY — recap before you commit

Re-check these before finishing any change (full text at the top + `.claude/rules/`):

1. **404, never 403** on ownership mismatch (IDOR)
2. **Zero try-catch** in route handlers for business/DB logic — let it bubble
3. **Fire-and-forget** redirect analytics — never awaited in the hot path
4. **Soft-delete only** (`is_deleted = true`) — never hard-`DELETE` a URL
5. **302, not 301** for redirects
6. **Reserved aliases** (`api`, `health`, `docs`, `admin`, `static`) → 400
7. **Prisma only in `*.repository.ts`** — handlers never touch `app.prisma`
8. **Consult before, verify after** — see `.claude/rules/invocations.md`
