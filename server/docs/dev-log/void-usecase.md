# The `void` Operator Convention

**Audience:** Backend developers reading `void` in front of expression statements and wondering whether it's meaningful or noise.

---

## What `void` Does

`void` is the JavaScript **`void` operator**. It evaluates the expression to its right and then returns `undefined` — discarding the expression's actual value.

At runtime, applying `void` to a Promise changes **nothing**: the Promise still runs, the async work still happens. It only discards the returned Promise. Its real job is at the *type / lint* layer:

- It satisfies the ESLint rule `@typescript-eslint/no-floating-promises`, which flags any Promise that isn't `await`-ed, `return`-ed, or `.catch()`-ed.
- It documents intent — **"I am deliberately not awaiting this; discard the result."** A reader (or reviewer) no longer has to wonder whether a missing `await` is a bug.

So removing `void` would not change behavior, but it would lose the lint guarantee and the signal of intent.

---

## Where It's Used in This Project

There are two distinct situations. Both are intentional.

### 1. Fire-and-forget on the redirect hot path

`redirect/src/routes/redirect.ts`

```ts
// Click analytics — enqueued async, never awaited.
void app.queue.enqueueClick(buildClickJob(request, shortCode));

// Cache population on a miss — also fire-and-forget.
void app.cache.set(shortCode, toCache, cacheTtl(url.expiresAt));
```

This is the **fire-and-forget** pattern mandated by `CLAUDE.md` rule #3:

> Redirect analytics → fire-and-forget — click event enqueued async, never awaited in the hot path.

`await`-ing these would add latency to the redirect, which must stay **<10ms p99**. The redirect must issue its `302` immediately; recording the click and warming the cache happen out-of-band. The `void` makes clear that the *absence* of `await` is the entire point — not an oversight.

> **Trade-off accepted:** a fire-and-forget Promise that rejects becomes an unhandled rejection. That's tolerable here because (a) the analytics enqueue/cache write is non-critical to serving the redirect, and (b) the process-level `unhandledRejection` handler in `shared/src/shutdown.ts` is the backstop.

### 2. Async function called from a synchronous callback

`shared/src/shutdown.ts`

```ts
process.on('SIGTERM', () => void drain('SIGTERM', 0));
process.on('SIGINT',  () => void drain('SIGINT', 0));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection — shutting down');
  void drain('unhandledRejection', 1);
});
```

`drain` is `async`, so it returns a Promise, but a `process.on` listener is expected to return `void`. The `void` operator does two jobs here:

- **Type fit:** `() => void drain(...)` makes the arrow return `undefined` instead of a `Promise`, matching the listener signature cleanly (no `() => { drain(); }` block needed).
- **Intent:** you *cannot* meaningfully `await` inside a synchronous signal listener anyway, and `drain` owns its own lifecycle (it ends by calling `process.exit`). `void` marks the un-awaited call as deliberate.

---

## When to Use It (and When Not To)

| Situation | Use `void`? |
|---|---|
| Promise you intentionally don't await (fire-and-forget) | ✅ Yes |
| Async function called from a sync callback (`process.on`, event listener) | ✅ Yes |
| Promise whose result or completion you actually need | ❌ No — `await` it |
| Promise where a failure must be handled | ❌ No — `await` in try/catch, or `.catch()` |

**Rule of thumb:** reach for `void` only when not awaiting is a deliberate design choice. If you're using `void` to silence the linter on a Promise you *should* be awaiting, that's a bug being hidden, not a pattern being applied.

---

## Related

- `CLAUDE.md` → rule #3 (fire-and-forget analytics)
- `docs/notes/exception-handling-strategy.md` → process-level fatal handlers
- `docs/dev-log/day-07-async-analytics-pipeline.md` → the BullMQ click queue this defers to
- `docs/dev-log/day-10-graceful-shutdown-error-handling.md` → `registerGracefulShutdown` / `drain`