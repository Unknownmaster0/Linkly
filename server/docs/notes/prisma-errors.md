# Prisma Error Reference

**URL Shortener + Analytics — Production Error Handling Guide**  
Stack: Fastify · Prisma · PostgreSQL · Valkey · BullMQ

---

## Overview

This document catalogues all Prisma client errors relevant to the URL shortener project. For each error, it provides the recommended HTTP status code, root cause analysis, and the handling pattern to implement in the Fastify global error handler.

> **Core principle:**  
> Infrastructure errors (P1xxx) → 5xx responses. Data/constraint errors (P2xxx) → 4xx responses. Never expose raw Prisma error messages to API consumers.

---

## Quick Reference

| Error Code | Error Name | HTTP Status | Category | Handler |
|---|---|---|---|---|
| `P1001` | Database Unreachable | 503 | Connection | Retry / 503 |
| `P1008` | Operation Timeout | 504 | Connection | Retry / 504 |
| `P1017` | Connection Closed | 503 | Connection | Retry / 503 |
| `P2002` | Unique Constraint Violated | 409 | Data | 409 Conflict |
| `P2003` | Foreign Key Violated | 400 | Data | 400 Bad Request |
| `P2004` | Constraint Failed | 400 | Data | 400 Bad Request |
| `P2005` | Invalid Field Value | 400 | Data | 400 Bad Request |
| `P2006` | Invalid Value for Type | 400 | Data | 400 Bad Request |
| `P2011` | Null Constraint Violated | 400 | Constraint | 400 Bad Request |
| `P2014` | Required Relation Violated | 400 | Constraint | 400 Bad Request |
| `P2015` | Related Record Not Found | 404 | Constraint | 404 Not Found |
| `P2016` | Query Interpretation Error | 500 | Query | 500 / log |
| `P2025` | Record Not Found | 404 | Query | 404 Not Found |
| `P2034` | Write Conflict / Deadlock | 409 | Transaction | Retry / 409 |

---

## Global Error Handler

Register a single `setErrorHandler` in `app.js` to intercept all unhandled Prisma errors. Routes should throw or let errors propagate — do not repeat error mapping logic in individual route files.

```js
// src/app.js — register after plugins and before routes
app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error, code: error.code }, 'Unhandled error');

  // ── Connection errors ──────────────────────────────────────
  if (error.code === 'P1001' || error.code === 'P1017') {
    reply.header('Retry-After', '30');
    return reply.code(503).send({ error: 'Service temporarily unavailable.' });
  }
  if (error.code === 'P1008') {
    reply.header('Retry-After', '5');
    return reply.code(504).send({ error: 'Request timed out.' });
  }

  // ── Data / constraint errors ───────────────────────────────
  if (error.code === 'P2002') {
    const field = error.meta?.target?.join(', ') ?? 'field';
    return reply.code(409).send({ error: `Conflict on ${field}.` });
  }
  if (['P2003','P2004','P2005','P2006','P2011','P2014'].includes(error.code)) {
    return reply.code(400).send({ error: 'Invalid request data.', detail: error.meta });
  }
  if (error.code === 'P2015' || error.code === 'P2025') {
    return reply.code(404).send({ error: 'Resource not found.' });
  }

  // ── Transaction / concurrency errors ──────────────────────
  if (error.code === 'P2034') {
    reply.header('Retry-After', '1');
    return reply.code(409).send({ error: 'Write conflict. Please retry.' });
  }

  // ── Fastify schema validation ──────────────────────────────
  if (error.validation) {
    return reply.code(400).send({ error: 'Validation failed', details: error.validation });
  }

  // ── Fallback ───────────────────────────────────────────────
  const status = error.statusCode || 500;
  reply.code(status).send({
    error: status === 500 ? 'Internal server error.' : error.message
  });
});
```

---

## Connection Errors (P1xxx)

P1xxx errors indicate failures at the database infrastructure level. They are never caused by the API client's request data and should always result in 5xx responses with `Retry-After` headers.

---

### `P1001` — Database Server Unreachable

- **HTTP Status:** `503 Service Unavailable`
- **Category:** Connection / Infrastructure

**Description**

Prisma cannot establish a connection to the database server. This is typically a network or infrastructure failure rather than an application bug.

**Possible Causes**

- Database server is down or restarting
- `DATABASE_URL` environment variable is incorrect or missing
- Docker container for PostgreSQL has not started yet (common during cold startup in Docker Compose)
- EC2 Security Group rules are blocking inbound connections on port `5432`
- The database host is unreachable from the application's network context

**Handling & Mitigation**

- Return HTTP `503` with a `Retry-After` header — the issue is infrastructure, not the client's request
- Log the full Prisma error (including `DATABASE_URL` host, sans credentials) at `ERROR` level for ops visibility
- Implement connection pool retry logic using Prisma's `connection_limit` and `connect_timeout` datasource options
- In Docker Compose, use `depends_on` with health checks to delay app startup until the database is ready
- Do NOT expose internal error details to the API consumer — return a generic message

**Handler Snippet**

```js
// In Fastify global error handler (app.js)
if (error.code === 'P1001') {
  reply.header('Retry-After', '30');
  return reply.code(503).send({
    error: 'Database unavailable. Please retry shortly.',
  });
}
```

---

### `P1008` — Operation Timed Out

- **HTTP Status:** `504 Gateway Timeout`
- **Category:** Connection / Performance

**Description**

A database operation exceeded the configured timeout window. This can indicate a slow query, a missing index, a deadlock, or a database under heavy load.

**Possible Causes**

- Missing index on a frequently queried column (e.g., `shortCode` lookup without an index)
- Analytics aggregation query scanning millions of rows without pre-aggregation
- Database under high write load causing read timeouts on replicas
- Connection pool exhausted — all connections are occupied, new requests wait and timeout
- `connect_timeout` configured too low for the environment's network latency

**Handling & Mitigation**

- Return HTTP `504` with a `Retry-After` header
- Log the operation type, table, and query duration to identify which queries are slow
- Add `connection_limit` and `pool_timeout` to `DATABASE_URL` for fine-grained control
- Run `EXPLAIN ANALYZE` on slow queries in PostgreSQL to identify missing indexes
- Consider query result caching in Valkey for expensive read operations like analytics aggregations

**Handler Snippet**

```js
if (error.code === 'P1008') {
  req.log.error({ err: error }, 'DB operation timeout');
  reply.header('Retry-After', '5');
  return reply.code(504).send({ error: 'Request timed out. Please retry.' });
}
```

---

### `P1017` — Server Closed the Connection

- **HTTP Status:** `503 Service Unavailable`
- **Category:** Connection / Lifecycle

**Description**

The database server closed an existing connection unexpectedly. This differs from `P1001` in that the initial connection succeeded, but the server terminated it mid-operation.

**Possible Causes**

- PostgreSQL `max_connections` limit reached — new or existing connections are being dropped
- Database server restart or failover event (e.g., EC2 instance reboot, RDS maintenance window)
- Idle connection timeout configured at the PostgreSQL level (`idle_in_transaction_session_timeout`)
- The Prisma connection pool holding stale connections that the server has already closed

**Handling & Mitigation**

- Return HTTP `503` — the error is transient and the client should retry
- Call `prisma.$disconnect()` and re-instantiate the client if this error persists
- Configure `connection_limit` appropriate for the environment (5 for free tier, 20 for production)
- Add `?connect_timeout=10&pool_timeout=15&connection_limit=10` to `DATABASE_URL`
- Implement an exponential backoff retry wrapper around database operations for idempotent queries

**Handler Snippet**

```js
if (error.code === 'P1017') {
  req.log.warn('DB connection dropped — pool will reconnect');
  return reply.code(503).send({ error: 'Connection interrupted. Please retry.' });
}
```

---

## Data & Constraint Errors (P2xxx — Client Errors)

P2xxx constraint and data errors are caused by request data that conflicts with the database schema or existing records. They result in 4xx responses. The client is responsible for sending corrected data.

---

### `P2002` — Unique Constraint Violation

- **HTTP Status:** `409 Conflict`
- **Category:** Data Integrity / Constraint

**Description**

A write operation attempted to create a record with a value that already exists in a column declared `UNIQUE`. In this project this most commonly occurs on the `shortCode` or `User.email` fields.

**Possible Causes**

- Custom alias submitted by the user is already taken (`Url.shortCode` unique constraint)
- User registration attempted with an email address that already exists (`User.email` unique constraint)
- A race condition in the Base62 counter strategy produced a duplicate short code under concurrent load
- A bulk insert includes duplicate values within the same batch

**Handling & Mitigation**

- Return HTTP `409 Conflict` — the client sent valid data, but it conflicts with existing state
- Inspect `error.meta.target` to identify the specific field that violated the constraint
- For custom aliases, suggest alternatives in the response body
- For user registration, return a generic message without confirming whether the email is in use (prevents account enumeration)
- For Base62 counter collisions, retry with `counter + 1` (idempotent retry loop, max 3 attempts)

**Handler Snippet**

```js
if (error.code === 'P2002') {
  const field = error.meta?.target?.join(', ') ?? 'field';
  return reply.code(409).send({
    error: 'Conflict',
    message: `A record with this ${field} already exists.`,
  });
}
```

---

### `P2003` — Foreign Key Constraint Violation

- **HTTP Status:** `400 Bad Request`
- **Category:** Data Integrity / Referential

**Description**

An operation referenced a record in a related table that does not exist. For example, creating a `Click` record for a `urlId` that no longer exists in the `Url` table.

**Possible Causes**

- A BullMQ click worker processes a job for a URL that was deleted between job enqueue and job processing
- An API consumer sends a `urlId` in a request body that does not correspond to any existing URL
- Race condition: parent record (`User` or `Url`) deleted concurrently while a child record (`Url` or `Click`) is being created

**Handling & Mitigation**

- Return HTTP `400 Bad Request` — the request references a non-existent resource
- In the BullMQ click worker, catch `P2003` and **discard the job without retrying** (the URL is gone — retrying will always fail)
- Inspect `error.meta.field_name` to identify which foreign key failed
- Implement soft-delete on the `Url` model (`is_deleted` flag) to prevent FK violations in the click pipeline

**Handler Snippet**

```js
// In clickWorker.js — discard job if URL was deleted
clickWorker.on('failed', (job, err) => {
  if (err.code === 'P2003') {
    req.log.warn({ jobId: job.id }, 'Click job discarded: URL no longer exists');
    // Do NOT re-throw — let BullMQ mark it as completed
    return;
  }
  req.log.error({ err }, 'Click worker unexpected failure');
});
```

---

### `P2004` — Constraint Failed on the Database

- **HTTP Status:** `400 Bad Request`
- **Category:** Data Integrity / Constraint

**Description**

A database-level constraint check failed that Prisma could not classify more specifically. This includes `CHECK` constraints defined directly in PostgreSQL migrations.

**Possible Causes**

- A `CHECK` constraint on `expiresAt` rejects a past date (e.g., expiry must be in the future)
- A custom PostgreSQL `TRIGGER` fires and raises an exception
- A constraint defined in a raw migration that Prisma's schema does not model

**Handling & Mitigation**

- Return HTTP `400 Bad Request`
- Log `error.meta.database_error` for the specific PostgreSQL constraint message
- Add application-level validation (Fastify JSON Schema) to catch these before they reach the database
- Document all raw `CHECK` constraints in the Prisma schema as comments to keep them visible to developers

**Handler Snippet**

```js
if (error.code === 'P2004') {
  req.log.warn({ meta: error.meta }, 'DB constraint check failed');
  return reply.code(400).send({ error: 'Invalid data: database constraint violated.' });
}
```

---

### `P2005` — Invalid Value Stored for Field Type

- **HTTP Status:** `400 Bad Request`
- **Category:** Data / Type Mismatch

**Description**

The value provided for a field does not conform to the field's type as defined in the Prisma schema. This is caught at the Prisma client layer before reaching the database.

**Possible Causes**

- Passing a string where an `Int` or `BigInt` is expected (e.g., a `shortCode` counter value parsed as a string)
- Providing a malformed `DateTime` string for a `DateTime` field such as `expiresAt`
- Sending `null` for a non-optional field in the Prisma query

**Handling & Mitigation**

- This error indicates a **bug in application code**, not a user error — prioritize fixing the source
- Return HTTP `400`, but also log at `ERROR` level for developer attention
- Add Fastify JSON Schema validation on all request bodies to coerce and validate types before they reach Prisma
- Use TypeScript to catch type mismatches at compile time

**Handler Snippet**

```js
if (error.code === 'P2005') {
  req.log.error({ err: error }, 'Prisma type mismatch — likely a code bug');
  return reply.code(400).send({ error: 'Invalid field type in request.' });
}
```

---

### `P2006` — Invalid Value for Type

- **HTTP Status:** `400 Bad Request`
- **Category:** Data / Type Mismatch

**Description**

Similar to `P2005`, but thrown when the provided value is syntactically valid but semantically incompatible with the target field type (e.g., a number that is out of range for an `Int`).

**Possible Causes**

- A `ttlDays` value exceeding PostgreSQL's `Int` range
- An enum value not defined in the Prisma schema being passed to an enum field
- A `BigInt` value passed as a plain number literal losing precision at `Number.MAX_SAFE_INTEGER`

**Handling & Mitigation**

- Return HTTP `400 Bad Request`
- Enforce enum validation and numeric range limits via Fastify JSON Schema (`minimum`, `maximum`, `enum` keywords) before the query reaches Prisma
- For `BigInt` handling, always use the `BigInt()` constructor explicitly — never coerce from `Number`

**Handler Snippet**

```js
if (error.code === 'P2006') {
  return reply.code(400).send({ error: 'Field value is out of range or invalid.' });
}
```

---

### `P2011` — Null Constraint Violated

- **HTTP Status:** `400 Bad Request`
- **Category:** Constraint / Required Field

**Description**

A `null` or `undefined` value was provided for a field that is required (non-nullable) in the Prisma schema. The column does not accept `NULL` values.

**Possible Causes**

- `originalUrl` not included in a URL creation request
- `userId` missing when creating a `Url` record — typically a missing `authenticate` middleware on a route
- Required field omitted from a Prisma `create()` call in the application code
- Prisma schema and database migration are out of sync (field is nullable in schema but `NOT NULL` in DB)

**Handling & Mitigation**

- Return HTTP `400 Bad Request`
- Inspect `error.meta.constraint` to identify the specific column
- Add Fastify JSON Schema validation with a `required` fields array to prevent null submissions from reaching Prisma
- **P2011 on `userId` almost always means the `authenticate` middleware was not applied to the route** — audit your route definitions

**Handler Snippet**

```js
if (error.code === 'P2011') {
  const field = error.meta?.constraint ?? 'field';
  return reply.code(400).send({
    error: `Required field '${field}' is missing.`
  });
}
```

---

### `P2014` — Required Relation Violated

- **HTTP Status:** `400 Bad Request`
- **Category:** Constraint / Relation

**Description**

An operation would break a required relation between two models. Prisma raised this before the query reached the database. This is distinct from `P2003` (a DB-level FK error) — `P2014` is caught at the Prisma query layer.

**Possible Causes**

- Attempting to disconnect a required relation (e.g., setting `url.user` to `null` when the relation is non-optional)
- Deleting a `User` record while it still has associated `Url` records and no cascade delete is configured
- Nested create/update operations that leave a required relation in an inconsistent state

**Handling & Mitigation**

- Return HTTP `400 Bad Request`
- Configure cascade deletes in Prisma schema using `onDelete: Cascade` for `Url → User` and `Click → Url` relationships
- For user deletion, explicitly decide policy: cascade-delete all URLs, or block deletion if URLs exist (return a descriptive `409`)
- Log `error.meta` for details on which relation is affected

**Handler Snippet**

```js
if (error.code === 'P2014') {
  return reply.code(400).send({
    error: 'Operation violates a required relationship constraint.',
    detail: error.meta?.relation_name ?? undefined,
  });
}
```

---

### `P2015` — Related Record Not Found

- **HTTP Status:** `404 Not Found`
- **Category:** Constraint / Relation

**Description**

A query required a related record to exist, but none was found. Common when using Prisma's nested operations with `connect` or `connectOrCreate` that cannot locate the target record.

**Possible Causes**

- `connect: { id: userId }` references a user that does not exist in the database
- Nested update with a `where` clause that matches no record
- Race condition: a related record was deleted between validation and the Prisma write operation

**Handling & Mitigation**

- Return HTTP `404 Not Found`
- Validate existence of related records before performing nested operations (e.g., verify the user exists before creating their URL)
- Consider using `connectOrCreate` where appropriate to handle missing related records gracefully

**Handler Snippet**

```js
if (error.code === 'P2015') {
  return reply.code(404).send({ error: 'Related record not found.' });
}
```

---

## Query & Not Found Errors (P2xxx — Application / Client)

These errors occur when Prisma cannot locate records or cannot interpret a query. `P2025` is the most common error in this project and requires security-conscious handling.

---

### `P2016` — Query Interpretation Error

- **HTTP Status:** `500 Internal Server Error`
- **Category:** Query / Application Bug

**Description**

Prisma could not interpret the query as written. This is **always a developer error** — a structural problem with the Prisma query itself, not user input. It should never reach production if code is properly tested.

**Possible Causes**

- Referencing a field name that does not exist in the Prisma schema in a `where` or `select` clause
- Using `include` on a relation that is not defined in the schema
- Malformed `orderBy`, `groupBy`, or `skip`/`take` combination that Prisma cannot translate to SQL

**Handling & Mitigation**

- Return HTTP `500` and log the full error immediately — this is a bug to fix, not a runtime condition to handle gracefully
- Never expose Prisma query details to the API consumer
- Add integration tests for all query paths to catch this class of error before deployment
- Enable Prisma query logging in development: `log: ['query', 'error']` in `PrismaClient` options

**Handler Snippet**

```js
if (error.code === 'P2016') {
  req.log.error({ err: error }, 'PRISMA QUERY BUG — fix immediately');
  return reply.code(500).send({ error: 'Internal server error.' });
}
```

---

### `P2025` — Record Not Found

- **HTTP Status:** `404 Not Found`
- **Category:** Query / Not Found

**Description**

The most frequently encountered Prisma error in this project. Prisma's `findUniqueOrThrow()` and `updateOrThrow()` variants throw `P2025` when no record matches the provided `where` clause. Also thrown by `update()` and `delete()` when no matching record exists.

**Possible Causes**

- `GET /:shortCode` requested for a short code that does not exist or has been deleted
- Analytics route requested for a `shortCode` that the authenticated user does not own
- `update()` or `delete()` called with a `where` clause that matches no rows (e.g., race condition — record was deleted between check and operation)
- Using `findUniqueOrThrow` instead of `findUnique` — the former throws on miss, the latter returns `null`

**Handling & Mitigation**

- Return HTTP `404 Not Found`
- For the redirect route: prefer `findUnique()` (returns `null`) over `findUniqueOrThrow()` — handle `null` explicitly without an exception in the hot path
- For ownership-scoped queries (analytics, delete): **return `404` even when the record exists but belongs to another user** — this prevents IDOR (Insecure Direct Object Reference) information leakage
- **Never return `403` for ownership mismatches** — returning `404` is the correct security posture (do not confirm that the resource exists)

**Handler Snippet**

```js
// Ownership-scoped 404 (security-correct pattern)
const url = await app.prisma.url.findUnique({
  where: { shortCode, userId }  // scope by owner — returns null if not owner
});
if (!url) return reply.code(404).send({ error: 'Not found.' });

// Global handler fallback for findUniqueOrThrow
if (error.code === 'P2025') {
  return reply.code(404).send({ error: 'Resource not found.' });
}
```

---

## Transaction & Concurrency Errors (P2xxx)

Concurrency errors occur under simultaneous writes and must be handled with client-side retry. The rate limiter and short code generation pipeline are the most likely sources in this project.

---

### `P2034` — Write Conflict or Deadlock

- **HTTP Status:** `409 Conflict`
- **Category:** Transaction / Concurrency

**Description**

A transaction failed due to a write conflict (optimistic concurrency control failure) or a database deadlock. PostgreSQL detected that two concurrent transactions were waiting on each other's locks and aborted one.

**Possible Causes**

- Two concurrent requests attempting to create or update a URL with the same short code simultaneously
- The rate limiter's token bucket read-modify-write cycle creating a deadlock under high concurrency (the race condition the Lua script approach solves)
- Bulk insert operations and single-record operations contending for the same table locks
- Analytics aggregation job running concurrently with high-volume click event inserts

**Handling & Mitigation**

- Return HTTP `409` with a `Retry-After` header (suggest 0–2 seconds for immediate retry)
- Implement an exponential backoff retry wrapper for operations known to conflict (e.g., the counter-based short code generation)
- For the rate limiter: use Valkey Lua scripts for atomicity — this eliminates the deadlock risk entirely for that operation
- Use Prisma Interactive Transactions (`$transaction`) with explicit retry logic for multi-step write operations

**Handler Snippet**

```js
if (error.code === 'P2034') {
  reply.header('Retry-After', '1');
  return reply.code(409).send({
    error: 'Write conflict. Please retry the request.',
  });
}
```

---

## Appendix: Debugging Prisma Errors

### Enable Prisma Query Logging in Development

```js
// src/plugins/db.js
export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('query', (e) => {
  console.log('Query:', e.query);
  console.log('Duration:', e.duration + 'ms');
});
```

### Inspecting `error.meta`

Every Prisma error includes a `meta` field with context specific to the error type. Always log this in development — never send it to API consumers in production.

```js
// What error.meta contains per error code:
// P2002 → { target: ['shortCode'] }          — violated unique field(s)
// P2003 → { field_name: 'urlId' }            — FK column name
// P2011 → { constraint: 'Url_userId_fkey' }  — constraint name
// P2025 → { cause: 'Record not found' }      — reason
// P2034 → { }                                — no additional meta
```

### Useful `DATABASE_URL` Parameters

```
DATABASE_URL="postgresql://user:pass@host:5432/db
  ?connection_limit=10
  &pool_timeout=15
  &connect_timeout=10
  &socket_timeout=30"
```

| Parameter | Effect |
|---|---|
| `connection_limit` | Max connections in Prisma's pool (default: 5 × CPU count — too high for free-tier DBs) |
| `pool_timeout` | Seconds to wait for a free connection from pool before throwing `P1008` |
| `connect_timeout` | Seconds to wait for initial connection before throwing `P1001` |
| `socket_timeout` | Seconds before an idle socket is closed |
