# File placement

Before implementing **any** route, service, repository, middleware, handler, or helper —
**read `../docs/notes/url-shortener-project-structure.md` first** and confirm:

1. The file belongs in the directory the structure doc specifies (e.g. services → `services/`, middleware → `middleware/`, helpers → `utils/`).
2. The naming convention matches the pattern already established in that section (e.g. `*.service.ts`, `*.job.ts`, `*.schema.ts`).
3. No new top-level directory or package is introduced without a matching entry in the structure doc.

**Never create a file in a location that contradicts the structure doc.**
If the structure doc does not cover the case, stop and ask before proceeding.
