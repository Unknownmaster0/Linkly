# Day 3 — Base62 Algorithm: Reasoning & Decisions

**Date:** 2026-04-24  
**Component:** `api/src/utils/base62.ts`

---

## Why BigInt?

PostgreSQL `BIGSERIAL` is a 64-bit integer with a max value of 2^63 − 1 (~9.2 × 10^18).
JavaScript `Number` is a 64-bit float that can only represent integers *exactly* up to 2^53 − 1 (~9 × 10^15).

Beyond `Number.MAX_SAFE_INTEGER`, JS silently rounds integer values:

```
9007199254740992 === 9007199254740993  // true in JS — silent data corruption
```

No error. No warning. The ID just changes silently. `BigInt` makes this a type error at compile time instead of a silent bug at runtime.

**Principle:** Production code is written for correctness at all scales, not convenience at current scale.

---

## The Alphabet

**Chosen:** `0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ` (standard, ordered)

**Why NOT shuffled:**  
A shuffled alphabet is security theater. An attacker seeing `short.ly/xK3` in the browser doesn't need to decode `xK3` back to a number — they simply enumerate `xK4`, `xK5`, `xK6`, etc. The sequence predictability is the threat, not the alphabet mapping. Real protection comes from rate limiting. Alphabet order is cosmetic only.

---

## encode() Logic

Base conversion: repeatedly divide `val` by 62, collect the remainders, map each remainder to the alphabet character at that index, then reverse the collected characters.

1. Edge case: if `val === 0n`, return `'0'` directly.
2. While `val > 0`: compute `remainder = val % 62n`, push `alphabet[remainder]` to array, then `val = val / 62n` (integer division).
3. Reverse the array and join — because remainders are collected least-significant digit first.

```
encode(62n):
  62n % 62n = 0  → '0'
  62n / 62n = 1
  1n % 62n  = 1  → '1'
  1n / 62n  = 0  → stop
  array = ['0', '1'] → reversed = ['1', '0'] → '10' ✓
```

---

## decode() Logic

Reverse of encode: treat each character as a digit in base-62, reconstruct the original number using positional value.

1. Split string, reverse it so index `i` corresponds to the `62^i` position.
2. For each character at position `i`: find its index in the alphabet, multiply by `62n ** BigInt(i)`, add to accumulator.
3. Return the accumulated `bigint`.

**Critical:** `Math.pow(62, i)` must NOT be used — it returns a `Number` that loses precision beyond `62^9`. Use `62n ** BigInt(i)` (BigInt exponentiation) throughout.

```
decode('10'):
  reversed = ['0', '1']
  i=0: indexOf('0') = 0 → 0n * 62n^0 = 0n
  i=1: indexOf('1') = 1 → 1n * 62n^1 = 62n
  total = 62n ✓
```

---

## Counter Strategy Decision

**Chosen:** PostgreSQL SEQUENCE (see DECISIONS.md #2 for full rationale)

**Why `url.count()` is a race condition:**

```
Thread A: count = await db.url.count()  // returns 1000
Thread B: count = await db.url.count()  // returns 1000 (same, before A inserts)
Thread A: encode(1000n) → 'g8'
Thread B: encode(1000n) → 'g8'  // COLLISION — same short code, two different URLs
```

Both threads read the same count before either inserts. The gap between read and insert is a classic TOCTOU (Time-of-Check-Time-of-Use) race. Under concurrent load this is not theoretical — it is guaranteed to happen.

**Why SEQUENCE wins:** PostgreSQL `nextval('sequence')` is atomic at the database level. No two callers ever receive the same value, regardless of concurrency. The counter lives inside PostgreSQL's transaction machinery — no application-level locking needed.

---

## PostgreSQL SEQUENCE + Prisma Integration

### Which sequence to use?

The `Url.id` column is `BIGSERIAL` (`@default(autoincrement())`). PostgreSQL automatically creates a sequence for it named using the pattern `{table_name}_{column_name}_seq`. Since the table is `urls` and the column is `id`, the sequence name is:

```
urls_id_seq
```

Reusing this avoids creating a separate sequence — no extra mapping overhead.

### Why not create a separate sequence?

A separate sequence would need to be manually created in a migration and mapped to nothing in the schema. The `urls_id_seq` already exists and is already scoped to the correct counter domain. Reusing it is the correct choice.

### Does passing `id` explicitly cause a double nextval() call?

No. `@default(autoincrement())` only fires when the field is **omitted** from the insert. When you explicitly pass `id`, Prisma uses your value directly. No double-increment.

### Final URL creation flow

```
1. const result = await db.$queryRaw`SELECT nextval('urls_id_seq') as id`
2. const id: BigInt = result[0].id          // type must be verified — Prisma may return string
3. const shortCode = encodeToBase62(id)
4. await prisma.url.create({
     data: { id, shortCode, originalUrl, userId, ... }
   })
```

**One round-trip to the DB for the counter, one for the insert. No race condition possible.**

### Why not Option B (insert first, update shortCode after)?

- Requires 2 DB round-trips
- Leaves a window where the row exists with no valid `shortCode`
- More complex rollback logic if the update fails

Option A is strictly better.

---

## Collision Risk Research

**Question asked:** "What are the collision risks with PostgreSQL SEQUENCE + Base62 encoding under concurrent writes?"

### Is collision possible on the standard path?

No. `nextval('urls_id_seq')` is guaranteed to return a unique value to every caller, even under maximum concurrency. PostgreSQL's sequence implementation is lock-free and atomic at the kernel level. Since `encodeToBase62()` is a pure deterministic function (same input → same output, different inputs → different outputs), unique IDs produce unique short codes. There is no collision risk on the standard code path.

### Sequence gaps are not collisions

When a transaction calls `nextval()` and then fails or rolls back, the sequence value is **consumed and not returned**. The result is a gap in IDs (e.g. 1001, 1003, 1005) — not a collision. Gaps are acceptable. Short codes do not need to be contiguous.

**Implication:** Do not treat gaps as errors. Do not attempt to "reclaim" skipped IDs — that reintroduces the race condition.

### Custom alias path is a separate risk

Custom aliases bypass the sequence entirely. Two concurrent requests could submit the same alias simultaneously. The sequence provides no protection here.

**Mitigation:** The `UNIQUE` constraint on `custom_alias` column handles this at the DB level. One insert succeeds, the other gets a `P2002` unique constraint violation from Prisma → handled by the global error handler → returns 409 Conflict to the client. No collision reaches the application layer.

### Sequence exhaustion is not a practical risk

`BIGSERIAL` max = 2^63 − 1 = ~9.2 × 10^18. At 100M URLs/day, exhaustion would occur in ~252 million years.

### Stress-test conclusion

The PostgreSQL SEQUENCE strategy has **zero collision risk** on the primary path. The only concurrent-write risk is custom alias conflicts, which are already covered by the DB unique constraint and global error handler. The decision to use SEQUENCE is correct and production-safe.
