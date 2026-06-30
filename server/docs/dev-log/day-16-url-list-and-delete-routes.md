# Day 16 — GET /api/urls & DELETE /api/urls/:shortCode

**Status:** Implemented (both routes shipped; type-check + code-review + security-review passed)
**Routes:** `GET /api/urls`, `DELETE /api/urls/:shortCode`
**Files touched:** `cache.ts`, `url.repository.ts`, `url.service.ts`, `url.ts` (route)

---

## What we're building

Two URL management routes that sit alongside the existing `POST /api/urls`:

| Route | Auth | Response | Side effects |
|---|---|---|---|
| `GET /api/urls` | Bearer token | 200 `{ urls, total }` | None |
| `DELETE /api/urls/:shortCode` | Bearer token | 204 no body | Soft-delete DB row, evict Valkey cache, set negative cache |

Both already have their TypeScript response interfaces defined in `url.schema.ts` (`UrlListItem`, `UrlListResult`). No schema file changes needed.

---

## Step 1 — Extend `cache.ts` plugin

Add `setDeleted(shortCode: string): Promise<void>` to the `ApiCacheClient` interface and implementation.

The API contract specifies a DELETE side effect: *"Negative cache entry set: `DELETED:gY1k` with 30s TTL"*. The redirect server reads this key to return 410 without hitting the DB for 30 seconds after deletion. The current plugin has no way to write it.

```ts
async setDeleted(shortCode: string): Promise<void> {
  try {
    await client.set(`DELETED:${shortCode}`, '1', 'EX', 30);
  } catch (err) {
    app.log.warn({ err }, 'Cache setDeleted failed');
  }
}
```

---

## Step 2 — Extend `url.repository.ts`

### `findByUserId(userId: string)`

Returns the caller's non-deleted URLs, newest first. The `select` pulls the
**denormalized `clickCount`** column (a `bigint`) — see the design note below.

```ts
interface UrlListRecord {
  shortCode: string;
  originalUrl: string;
  customAlias: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  clickCount: bigint;
}

async findByUserId(userId: string): Promise<UrlListRecord[]> {
  return prisma.url.findMany({
    where: { userId, isDeleted: false },
    orderBy: { createdAt: 'desc' },
    select: {
      shortCode: true,
      originalUrl: true,
      customAlias: true,
      expiresAt: true,
      createdAt: true,
      clickCount: true,
    },
  });
}
```

### `softDeleteByCode(code: string, userId: string)`

The `:shortCode` param can be either a real shortCode **or** a customAlias (the contract says "Short code or custom alias"). Uses a Prisma **interactive transaction** to make the find + update atomic.

```ts
async softDeleteByCode(code: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const record = await tx.url.findFirst({
      where: {
        OR: [{ shortCode: code }, { customAlias: code }],
        userId,
        isDeleted: false,
      },
      select: { shortCode: true, customAlias: true },
    });
    if (!record) return null;

    await tx.url.update({
      where: { shortCode: record.shortCode },
      data: { isDeleted: true },
    });

    return record;
  });
}
```

**Why a transaction:** Without it, a gap exists between the `findFirst` (ownership check) and the `update`. A concurrent DELETE request in that window would observe the same row as not-deleted and both calls would proceed. The transaction makes the find + update atomic — if the update throws, the find result is discarded and the service correctly surfaces the error rather than operating on a record that was never actually changed.

---

## Step 3 — Extend `url.service.ts`

### `listUrls(userId: string): Promise<UrlListResult>`

```ts
const records = await repo.findByUserId(userId);
const urls = records.map(r => ({
  shortCode: r.shortCode,
  shortUrl: `${config.BASE_URL}/${r.customAlias ?? r.shortCode}`,
  originalUrl: r.originalUrl,
  customAlias: r.customAlias,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
  clickCount: Number(r.clickCount),  // BigInt → number (see note below)
  isDeleted: false,                   // constant: repo filters out deleted rows
}));
return { urls, total: urls.length };
```

### `deleteUrl(code: string, userId: string): Promise<{ shortCode: string; customAlias: string | null }>`

```ts
const record = await repo.softDeleteByCode(code, userId);
if (!record) throw new OwnershipError();  // 404; see note below
return record;  // returned so the route handler can evict the correct cache key
```

The service stays clean of cache concerns. It returns the record so the route handler knows which shortCode to evict.

> **`OwnershipError`, not `NotFoundError` (corrected during implementation).** The
> repository query is scoped by `userId`, so a `null` result means "doesn't exist
> **or** isn't yours" — indistinguishable by design. `exception-handling-strategy.md`
> (the locked authority doc) maps `DELETE /api/urls/:code` → `OwnershipError`
> explicitly. Both classes resolve to an identical `404 { "error": "Not found" }`,
> but `OwnershipError` self-documents the IDOR guard, so the shipped code uses it.

---

## Step 4 — Extend `url.ts` route

### GET /urls

```ts
app.get('/urls',
  { preHandler: [authenticate], schema: listUrlsSchema },
  async (request, reply) => {
    const result = await urlService.listUrls(request.userId);
    return reply.status(200).send(successResponse('URLs retrieved', result));
  }
);
```

### DELETE /urls/:shortCode

```ts
app.delete<{ Params: { shortCode: string } }>(
  '/urls/:shortCode',
  { preHandler: [authenticate], schema: deleteUrlSchema },
  async (request, reply) => {
    const { shortCode } = request.params;
    const record = await urlService.deleteUrl(shortCode, request.userId);

    await app.cache.del(record.shortCode);
    await app.cache.setDeleted(record.shortCode);

    return reply.status(204).send();
  }
);
```

**Cache eviction is in the route handler, not the service:** The service takes only `prisma`. Cache is infrastructure — same layer as the handler.

---

## OpenAPI schemas (in the route file)

**GET /urls** — no request schema; success wraps `UrlListResult`:

```ts
// Data-payload schemas (docs only). The item mirrors UrlListItem in url.schema.ts.
const urlListItemSchema = {
  type: 'object',
  properties: {
    shortCode: { type: 'string', example: 'gY1k' },
    shortUrl: { type: 'string', example: 'https://short.url/gY1k' },
    originalUrl: { type: 'string', example: 'https://example.com/very/long/url' },
    customAlias: { type: 'string', nullable: true, example: 'my-project' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    clickCount: { type: 'integer', example: 42 },
    isDeleted: { type: 'boolean', example: false },
  },
} as const;

const urlListResultSchema = {
  type: 'object',
  properties: {
    urls: { type: 'array', items: urlListItemSchema },
    total: { type: 'integer', example: 2 },
  },
} as const;

const listUrlsSchema = {
  tags: ['URLs'],
  summary: 'List URLs created by the authenticated user',
  security: [{ bearerAuth: [] }],
  response: {
    200: successEnvelope(urlListResultSchema, 'URLs retrieved'),
    401: errorEnvelope('Not authenticated', { error: 'Unauthorized' }),
  },
};
```

**DELETE /urls/:shortCode** — path param; 204 has no body:

```ts
const deleteUrlSchema = {
  tags: ['URLs'],
  summary: 'Soft-delete a short URL',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    properties: { shortCode: { type: 'string', example: 'gY1k' } },
    required: ['shortCode'],
  },
  response: {
    204: { description: 'Deleted successfully', type: 'null' },
    401: errorEnvelope('Not authenticated', { error: 'Unauthorized' }),
    404: errorEnvelope('Not found', { error: 'Not found' }),
  },
};
```

---

## Design decisions made during planning

### Cache eviction: shortCode only (not customAlias)

Initial plan evicted both `url:shortCode` and `url:customAlias`. After reviewing the create path in `url.service.ts`:

```ts
// Custom alias path — both columns set to the same value
repo.create({ shortCode: alias, customAlias: alias, ... })
```

When a custom alias is provided, `shortCode` IS the alias. There is never a row where `customAlias` differs from `shortCode`. The redirect server caches under `url:${shortCode}`, so evicting `url:${record.shortCode}` covers all cases. Evicting the alias separately is redundant.

Same reasoning applies to `setDeleted` — only `setDeleted(record.shortCode)` is needed.

### clickCount source: denormalized counter, not a live COUNT(*)

`clickCount` is read straight from the `urls.click_count` column — **not** computed with
`COUNT(*)` over `click_events`. That column is a denormalized counter the analytics
worker maintains write-behind: the redirect server enqueues a click to the
`click-events` BullMQ queue → the worker's click processor INSERTs the raw
`click_events` row and accumulates a per-URL delta → a batched transaction applies
`UPDATE urls SET click_count = click_count + <delta>`. Reading the counter keeps the
list endpoint O(1) per row (`DECISIONS.md` denormalization; `db-design` §"Example 3:
List User's URLs"). The value is eventually consistent — acceptable for analytics, and
the API contract's "aggregated from Click table" describes how the counter is *sourced*,
not a per-request aggregation.

### BigInt → Number conversion

`clickCount` is `bigint` in the Prisma model (PostgreSQL `BIGINT` column). `JSON.stringify(BigInt(42))` throws `TypeError: Do not know how to serialize a BigInt` — so the conversion is non-optional.

`Number()` is used rather than `String()` because the API contract specifies `clickCount` as a JSON integer, not a string. Overflow risk: `Number.MAX_SAFE_INTEGER = 2^53 - 1 ≈ 9 quadrillion`. At 1 million clicks per second, overflow takes ~285 years — not a practical concern for this domain.

---

## Files changed — summary

| File | Change |
|---|---|
| `api/src/plugins/cache.ts` | Add `setDeleted(shortCode)` to `ApiCacheClient` interface + implementation |
| `api/src/repositories/url.repository.ts` | Add `findByUserId`, `softDeleteByCode` (with transaction) |
| `api/src/services/url.service.ts` | Add `listUrls`, `deleteUrl` |
| `api/src/routes/url.ts` | Add `GET /urls` + `DELETE /urls/:shortCode` handlers + OpenAPI schemas |

No new files. `url.schema.ts` untouched (`UrlListItem` and `UrlListResult` already defined).

---

## Five things that will bite you if missed

1. **BigInt serialization** — `clickCount` is `bigint` in Prisma; always `Number(r.clickCount)` before returning JSON
2. **OR clause in soft-delete repo** — `:shortCode` param can be the customAlias; search `{ OR: [{ shortCode: code }, { customAlias: code }] }`
3. **Transaction for find + update** — use `prisma.$transaction` to make the ownership check and soft-delete atomic
4. **Return the record from service** — route handler needs `record.shortCode` to evict the correct Valkey key
5. **204 sends no body** — `reply.status(204).send()` with no argument; OpenAPI schema `type: 'null'` not a success envelope

---

## Verification (after writing)

Per `.claude/rules/invocations.md`:

1. `npm run type-check` in `api/` (BigInt → Number, `UrlListResult` shape).
2. **`code-reviewer`** agent — locked-doc compliance (IDOR/404, zero try-catch, repository-only Prisma, envelope shape).
3. **`unit-test-generator`** agent — Vitest coverage for the happy path + 401.
4. **`/validate-implementation`** before merging the feature branch.

---

## Implementation order

`GET /api/urls` was implemented first, then `DELETE /api/urls/:shortCode` (including
its `cache.ts` `setDeleted` addition). Both are now shipped. The only deviation from
this plan is the `OwnershipError` correction noted in Step 3.
