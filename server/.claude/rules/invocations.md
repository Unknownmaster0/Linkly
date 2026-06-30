# Skill & agent invocations

Two phases: **consult before** writing (load the rules), **verify after** writing (check the
code against them). Skipping either is a process violation.

Skills and agents auto-trigger on their own `description`, but the bindings below are
**mandatory** — invoke them on the stated condition even if not prompted. Each row names the
authority doc(s) that skill/agent enforces, so the chain is explicit:
`condition → skill/agent → docs it checks against`.

## Before you write — consult

| When you are about to… | Invoke | Which enforces |
|---|---|---|
| Create any new file (route, service, middleware, handler, helper) | read `../docs/notes/url-shortener-project-structure.md` first | the structure/placement doc |
| Add or change a **route / endpoint / API contract** | `/api-design` | `../docs/notes/API_CONTRACT.md` |
| Write or change **error-handling** code | `/error-handling` | `../docs/notes/ERROR_CONTRACT.md`, `docs/notes/exception-handling-strategy.md`, `docs/notes/prisma-errors.md` |
| Write unit/integration **tests** | `unit-test-generator` agent | `API_CONTRACT.md`, `ERROR_CONTRACT.md`, `DECISIONS.md` (plans first, then generates Vitest) |

## After you write — verify

| When you have just… | Invoke | Which checks against |
|---|---|---|
| Written/modified a route, handler, or error path | `code-reviewer` agent | all locked docs (`DECISIONS.md`, `API_CONTRACT.md`, `ERROR_CONTRACT.md`, `exception-handling-strategy.md`, `prisma-errors.md`, schema) |
| Written any **auth or ownership** code (before merge) | `/security-reviewer` | IDOR/404 rule, JWT & password policy, `DECISIONS.md` |
| Finished a feature (before merging the branch) | `/validate-implementation` | full spec compliance sweep |
| Completed an implementation **day** | `day-end-audit` agent (or `/day-audit`) | standards docs → updates `docs/dev-todos/todos.md` |

## Agent reference (`.claude/agents/`)

| Agent | Tools | Role |
|---|---|---|
| `code-reviewer` | read-only | Compliance review against locked docs (IDOR/contract/decision checks) |
| `day-end-audit` | read + edit todos | End-of-day standards audit → `docs/dev-todos/todos.md` |
| `unit-test-generator` | read + write tests | Vitest unit/integration tests derived from authority docs |
