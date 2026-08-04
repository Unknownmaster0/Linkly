# Production-Grade URL Shortener — System Design Deep Dive

> **Audience:** Backend engineers who want to understand *why* decisions are made, not just what to build.
> **Goal:** Think like a system designer, not a tutorial follower.

---

## Table of Contents

1. [System Scope & Mental Model](#1-system-scope--mental-model)
2. [Features Breakdown](#2-features-breakdown)
3. [API Design](#3-api-design)
4. [Database Design](#4-database-design)
5. [System Architecture](#5-system-architecture)
6. [URL Generation Strategy](#6-url-generation-strategy)
7. [Day-by-Day Execution Plan](#7-day-by-day-execution-plan)
8. [Edge Cases & Failure Handling](#8-edge-cases--failure-handling)
9. [Performance & Optimization](#9-performance--optimization)
10. [Interview Perspective](#10-interview-perspective)

---

## 1. System Scope & Mental Model

### What problem are we actually solving?

Before any technical decision, understand the core contract this system must honor:

> **A user gives you a long URL. You give back a short code. When someone visits that short code, they must arrive at the long URL — fast, always, at any scale.**

Everything else — analytics, auth, expiry — is layered on top of this three-word contract: **shorten, store, redirect**.

### Traffic Characteristics (Design Inputs)

You cannot design a system without knowing its load profile. A URL shortener has a deeply **asymmetric** read-write ratio:

| Operation | Estimated Ratio | Why |
|---|---|---|
| URL Creation (writes) | 1x | Only the owner shortens a URL once |
| URL Redirection (reads) | 100x–1000x | Every share, every click, every embed |
| Analytics reads | 10x | Dashboards, reports |

This asymmetry is the most important design input. **Your entire architecture bends around optimizing the read path (redirection)**, because that's what users feel. A 50ms write is invisible. A 50ms redirect is noticeable. A 500ms redirect is broken.

### Scale Envelope (Back-of-Envelope Thinking)

For a Bitly-scale system, reason like this:

- **100 million URLs shortened per day** → ~1,160 writes/second
- **10 billion redirects per day** → ~115,000 reads/second
- **Storage per URL record** → ~500 bytes average → 100M * 500B = ~50GB/day

This tells you:
- A single database cannot handle 115K reads/second — you need caching
- 50GB/day of storage growth means you need a partitioning/archival strategy within months
- Write load is manageable on a single primary DB with read replicas

---

## 2. Features Breakdown

### Core Features (Must-Have for MVP)

#### URL Shortening
**Why it exists:** The primary value proposition. A user submits a long URL and receives a short, shareable code.

**Trade-offs:**
- **Random short code vs. sequential ID:** Random codes (Base62 encoded) are unpredictable and resist enumeration attacks. Sequential IDs are simpler but leak business metrics (total URLs created) and allow attackers to iterate through all short codes.
- **Custom aliases:** Users want memorable links (`domain.com/sale2024`). This adds a uniqueness constraint on user-defined strings and requires collision detection against randomly generated codes.

#### Redirection
**Why it exists:** The core read path. Every click is a redirect request.

**Trade-offs:**
- **301 (Permanent) vs. 302 (Temporary):** 301 tells browsers to cache the redirect — subsequent clicks never hit your server, reducing load. But you lose analytics data for those cached requests. 302 forces every click through your server, giving you full analytics but higher load. **The industry answer:** Use 302 for analytics-enabled links, 301 only for legacy/permanent redirects where analytics don't matter.

#### Analytics Tracking
**Why it exists:** URL shorteners monetize on analytics. Knowing click counts, geographic distribution, referrers, and device types is the product's value beyond the shortening itself.

**Trade-offs:**
- **Synchronous vs. asynchronous tracking:** If you record analytics in the same request that processes the redirect, you add database write latency to the user's click experience. This is unacceptable. Analytics must be fire-and-forget — the redirect response goes out immediately, and the click event is queued for async processing.
- **Granularity vs. storage cost:** Storing every click event (timestamp, IP, referrer, user-agent) gives you full drill-down capability but costs significant storage at scale. Aggregated counters (click count per day) are cheap but irreversible — you can't reconstruct granular data later.

#### User Authentication
**Why it exists:** Users need to own their URLs, manage them, and access their analytics. Without auth, any URL can be deleted or claimed by anyone.

**Trade-offs:**
- **JWT vs. Session:** For a stateless API with mobile clients and potential microservices architecture, JWT is the right default. But use short-lived access tokens (10 minutes) + refresh tokens stored in the database (not just signed — stored, so they can be revoked). Pure stateless JWT with no revocation is a security liability.

---

### Advanced Features (Real-World Improvements)

#### Link Expiration (TTL)
**Why it exists:** Temporary links for campaigns, one-time use codes, privacy. Also a mechanism to control storage growth.

**Trade-offs:** Expiry can be enforced two ways — eagerly (a background job deletes expired records) or lazily (check expiry at redirect time, return 410 Gone). Lazy expiry is simpler but means dead records accumulate. Eager expiry keeps storage clean but requires a reliable scheduled job. **Production answer:** do both — lazy check at redirect time for correctness, eager cleanup for storage efficiency.

#### Custom Domains
**Why it exists:** Enterprises want `go.company.com/q1report` not `bit.ly/abc123`. It's the premium tier feature.

**Trade-offs:** Custom domains require DNS verification, TLS certificate management (Let's Encrypt ACME protocol), and per-tenant routing logic at the load balancer level. This is significant operational complexity — defer until after core is solid.

#### Bulk URL Creation
**Why it exists:** Marketing teams generate thousands of campaign-specific links programmatically via API.

**Trade-offs:** Naive bulk creation (loop over 10,000 URLs one by one) creates 10,000 individual database round-trips. You need batch insertion with conflict handling. This is a write-path optimization problem.

#### QR Code Generation
**Why it exists:** Physical marketing materials (posters, packaging) need scannable codes. QR is just a rendering of the short URL.

**Trade-offs:** Generate on-demand and cache, or pre-generate on creation. On-demand + cache (with a CDN) is correct — not every URL gets a QR scan, so pre-generating wastes compute.

---

### Production Features (Scaling, Reliability, Security)

#### Rate Limiting
**Why it exists:** Without it, a single bad actor can exhaust your URL creation quota, flood your redirect infrastructure, or enumerate short codes. Also protects against bots inflating analytics.

**Trade-offs:** Rate limiting in-process (token bucket in memory) doesn't work in a horizontally scaled system — each instance has its own counter. Rate limiting must be centralized in your cache layer (Valkey/Redis) so all instances share the same counter. The trade-off is that the rate limiter itself becomes a dependency — if Valkey is down, what do you do? Fail open (allow the request) or fail closed (reject it)? For a URL shortener, **fail open** is the right default — brief rate limiter unavailability is preferable to a full outage.

#### Link Preview / Safety Scanning
**Why it exists:** Malicious actors use URL shorteners to disguise phishing links. Google Safe Browsing API (free tier) lets you check URLs against known malicious lists before shortening.

**Trade-offs:** Adds latency to the creation path. Async scanning (create first, scan in background, flag/disable if malicious) is the right architecture for creation speed, with a brief window of exposure.

#### Webhook Notifications
**Why it exists:** Enterprise users want their systems notified on click events without polling your analytics API. Event-driven integration pattern.

**Trade-offs:** You're now responsible for reliable delivery to external systems — retries, dead-letter handling, and backpressure management. This is a significant commitment. Use an outbox pattern (write webhook payload to DB atomically with the event, process from DB) to guarantee no events are lost.

---

## 3. API Design

### Versioning Strategy

All routes are prefixed with `/api/v1/`. Versioning in the URL is pragmatic for a public API — header-based versioning (`Accept: application/vnd.api+json; version=1`) is more RESTfully pure but harder to debug and test.

---

### Authentication Routes

#### Register
```
POST /api/v1/auth/register

Request Body:
{
  email: string (validated format),
  password: string (min 8 chars, breached password check),
  name: string
}

Response 201:
{
  userId: uuid,
  email: string,
  accessToken: string (JWT, 10min expiry),
  refreshToken: string (opaque token, 30 days)
}

Response 409: Email already registered
Response 422: Validation failure with field-level errors
```

#### Login
```
POST /api/v1/auth/login

Request Body:
{
  email: string,
  password: string
}

Response 200:
{
  accessToken: string,
  refreshToken: string,
  expiresIn: 900  // seconds
}

Response 401: Invalid credentials (do NOT distinguish between "email not found" vs "wrong password" — information leak)
Response 429: Rate limit exceeded (per-IP + per-account)
```

#### Token Refresh
```
POST /api/v1/auth/refresh

Request Body:
{
  refreshToken: string
}

Response 200:
{
  accessToken: string,
  expiresIn: 900
}

Response 401: Refresh token invalid, expired, or revoked
```

#### Logout
```
POST /api/v1/auth/logout

Auth: Bearer token required

Request Body:
{
  refreshToken: string  // revoke this specific refresh token
}

Response 204: No content
```

---

### URL Management Routes

#### Create Short URL
```
POST /api/v1/urls

Auth: Bearer token required

Request Body:
{
  originalUrl: string (required, validated URL format),
  customAlias: string (optional, alphanumeric + hyphens, 3-50 chars),
  expiresAt: ISO8601 datetime (optional),
  tags: string[] (optional, for user organization)
}

Response 201:
{
  shortCode: string,
  shortUrl: string (full URL: https://domain.com/abc123),
  originalUrl: string,
  customAlias: string | null,
  expiresAt: datetime | null,
  createdAt: datetime
}

Response 409: Custom alias already taken
Response 422: Invalid URL format / validation failure
Response 429: Rate limit exceeded

Notes:
- originalUrl undergoes format validation AND safe-browsing check (async, non-blocking)
- shortCode generated server-side using Base62(counter) strategy
- If customAlias provided, it becomes the shortCode
```

#### Get All URLs for User
```
GET /api/v1/urls

Auth: Bearer token required

Query Parameters:
{
  page: integer (default: 1),
  limit: integer (default: 20, max: 100),
  sortBy: "createdAt" | "clicks" | "expiresAt" (default: "createdAt"),
  order: "asc" | "desc" (default: "desc"),
  tag: string (optional filter),
  search: string (optional, searches originalUrl and alias)
}

Response 200:
{
  data: URL[],
  pagination: {
    total: integer,
    page: integer,
    limit: integer,
    hasNext: boolean
  }
}
```

#### Get Single URL
```
GET /api/v1/urls/:shortCode

Auth: Bearer token required (ownership enforced)

Response 200:
{
  shortCode: string,
  shortUrl: string,
  originalUrl: string,
  clickCount: integer,
  createdAt: datetime,
  expiresAt: datetime | null,
  isActive: boolean
}

Response 404: Not found (same response whether URL doesn't exist OR belongs to another user — prevent enumeration)
```

#### Update URL
```
PATCH /api/v1/urls/:shortCode

Auth: Bearer token required (ownership enforced)

Request Body (all fields optional):
{
  originalUrl: string,
  customAlias: string,
  expiresAt: datetime | null,  // null to remove expiry
  isActive: boolean             // soft disable without deletion
}

Response 200: Updated URL object
Response 404: Not found / not owned by user
Response 409: Custom alias already taken
```

#### Delete URL
```
DELETE /api/v1/urls/:shortCode

Auth: Bearer token required (ownership enforced)

Response 204: No content
Response 404: Not found / not owned by user

Notes:
- Soft delete (isDeleted flag) is preferred over hard delete
- Hard delete loses analytics history
- Redirect will return 410 Gone for soft-deleted URLs
```

---

### Redirect Route

This is the highest-traffic route in the entire system. It lives outside the `/api/v1/` prefix because it's a public-facing URL.

```
GET /:shortCode

Auth: None required (public)

Headers Read (for analytics):
  User-Agent: device/browser detection
  Referer: traffic source tracking
  X-Forwarded-For: IP for geolocation (use with care — GDPR implications)

Response 302: Found
  Location: https://original-long-url.com

Response 404: Short code not found
Response 410: Gone (URL was deleted or permanently expired)
Response 451: Unavailable For Legal Reasons (if flagged as malicious/DMCA)

Notes:
- This endpoint must complete in under 10ms at p99
- No auth overhead on this path
- Analytics event is fire-and-forget into a message queue
- Response is served BEFORE analytics are written
- Cache hit path: Valkey lookup → 302. No database involved.
- Cache miss path: Valkey lookup → DB lookup → 302 → async cache write
```

---

### Analytics Routes

#### Get Summary Analytics
```
GET /api/v1/urls/:shortCode/analytics/summary

Auth: Bearer token required (ownership enforced)

Query Parameters:
{
  from: ISO8601 date (default: 30 days ago),
  to: ISO8601 date (default: now)
}

Response 200:
{
  shortCode: string,
  totalClicks: integer,
  uniqueClicks: integer,      // distinct IPs (approximate, privacy-preserving)
  clicksByDay: [              // time series
    { date: "2024-01-01", clicks: 342 }
  ],
  topReferrers: [
    { referrer: "twitter.com", clicks: 891, percentage: 26.3 }
  ],
  topCountries: [
    { country: "IN", clicks: 1240, percentage: 36.4 }
  ],
  deviceBreakdown: {
    mobile: 65.2,
    desktop: 31.4,
    tablet: 3.4
  }
}
```

#### Get Raw Click Events
```
GET /api/v1/urls/:shortCode/analytics/events

Auth: Bearer token required (ownership enforced)

Query Parameters:
{
  page: integer,
  limit: integer (max: 100),
  from: date,
  to: date
}

Response 200:
{
  data: [
    {
      clickedAt: datetime,
      country: string,
      city: string,
      device: "mobile" | "desktop" | "tablet",
      browser: string,
      referrer: string,
      isUnique: boolean
    }
  ],
  pagination: { ... }
}

Notes:
- Raw events are stored for 90 days, then aggregated and purged (cost management)
- IP addresses are never returned — stored hashed for uniqueness detection
```

#### Export Analytics
```
GET /api/v1/urls/:shortCode/analytics/export

Auth: Bearer token required

Query Parameters:
{
  format: "csv" | "json",
  from: date,
  to: date
}

Response 202: Accepted (export is async for large datasets)
{
  jobId: string,
  status: "processing",
  estimatedCompletionTime: datetime
}

Notes:
- For small datasets (< 10K rows), synchronous response with file
- For large datasets, background job generates file → upload to S3 → signed URL sent via webhook/email
```

---

### System Routes

```
GET /health
Response 200: { status: "ok", uptime: seconds, version: string }

GET /api/v1/check/:shortCode
Purpose: Check if a custom alias is available before creation
Auth: Bearer token required
Response 200: { available: boolean }
```

---

## 4. Database Design

### Why Relational (PostgreSQL) Over NoSQL

This is a common interview question. The reasoning:

**Choose SQL when:**
- Data has clear relationships (User owns URLs; URLs have Clicks)
- You need ACID guarantees (a URL and its initial analytics record should be created atomically)
- Your access patterns are known and relational joins are needed (analytics queries)
- You want schema enforcement as a correctness tool

**Where NoSQL might make sense here:**
- Click events table — extremely high write volume, append-only, no relational complexity. A time-series database (TimescaleDB, a PostgreSQL extension) or a columnar store (ClickHouse) would outperform standard PostgreSQL for analytics queries at scale.
- The pragmatic answer for this project: start with PostgreSQL everywhere. Migrate click events to ClickHouse when query performance degrades. Don't over-engineer upfront.

---

### Schema Design

#### Users Table

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID | Primary key. UUID prevents ID enumeration. |
| `email` | VARCHAR(255) | Login identifier. Unique constraint. |
| `password_hash` | VARCHAR(255) | Argon2id hash. Never plaintext, never bcrypt. |
| `name` | VARCHAR(100) | Display name |
| `plan` | ENUM('free', 'pro', 'enterprise') | Feature gating and rate limit tiers |
| `is_verified` | BOOLEAN | Email verification gate |
| `is_active` | BOOLEAN | Soft disable without deletion |
| `created_at` | TIMESTAMPTZ | Timezone-aware timestamp (always store in UTC) |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger |

**Indexes:**
- `UNIQUE INDEX` on `email` — for login lookup
- No index on `created_at` yet — not queried frequently enough to justify

---

#### Refresh Tokens Table

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID | Primary key |
| `user_id` | UUID | Foreign key → Users |
| `token_hash` | VARCHAR(64) | SHA-256 hash of the opaque token. Never store the raw token. |
| `expires_at` | TIMESTAMPTZ | TTL for the token |
| `revoked_at` | TIMESTAMPTZ | NULL if active; set on logout or rotation |
| `user_agent` | VARCHAR(500) | Which device/browser created this token |
| `created_at` | TIMESTAMPTZ | |

**Why a separate table instead of JWT-only refresh:** This lets you list "active sessions," revoke specific devices, and detect token theft via rotation. JWT-only refresh can never be revoked without a blacklist — this table IS the blacklist, but structured as an allowlist (more efficient).

**Indexes:**
- `INDEX` on `token_hash` — for refresh validation lookup
- `INDEX` on `user_id` — for "list active sessions" query

---

#### URLs Table

| Column | Type | Purpose |
|---|---|---|
| `id` | BIGSERIAL | Internal auto-increment PK. Used for Base62 encoding into shortCode. |
| `short_code` | VARCHAR(12) | The generated or custom short identifier. Globally unique. |
| `original_url` | TEXT | The destination URL. TEXT not VARCHAR — URLs can be very long. |
| `user_id` | UUID | FK → Users. Owner. NULL for anonymous/guest links. |
| `custom_alias` | VARCHAR(50) | User-provided alias, NULL if auto-generated |
| `expires_at` | TIMESTAMPTZ | NULL = never expires |
| `click_count` | BIGINT | Denormalized counter. Updated asynchronously from click events. |
| `is_active` | BOOLEAN | Soft disable by owner |
| `is_deleted` | BOOLEAN | Soft delete |
| `is_flagged` | BOOLEAN | Malicious URL flag from safety scanning |
| `tags` | TEXT[] | PostgreSQL array for user-defined tags |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Why `BIGSERIAL` for id and `VARCHAR` for short_code as separate columns?**
The `id` is your encoding input (the integer you Base62-encode). The `short_code` is the resulting string. Keeping them separate lets you regenerate the short_code if your encoding algorithm changes, and allows custom aliases to be stored in the same column with no integer relationship.

**Indexes:**
- `UNIQUE INDEX` on `short_code` — the most critical index in the system. Every redirect does a lookup by this column.
- `INDEX` on `user_id` — for "list all URLs for a user"
- `INDEX` on `expires_at` — for the background expiry cleanup job (partial index: `WHERE expires_at IS NOT NULL AND expires_at < NOW()`)
- `INDEX` on `(user_id, created_at DESC)` — composite index for the paginated URL list sorted by creation date

---

#### Click Events Table

| Column | Type | Purpose |
|---|---|---|
| `id` | BIGSERIAL | PK |
| `url_id` | BIGINT | FK → URLs |
| `clicked_at` | TIMESTAMPTZ | When the click happened |
| `ip_hash` | VARCHAR(64) | SHA-256(IP + daily_salt). Never raw IP — GDPR/privacy. Daily salt means the hash rotates every 24h, preventing long-term tracking while still enabling same-day unique detection. |
| `country_code` | CHAR(2) | ISO country code from IP geolocation |
| `city` | VARCHAR(100) | City from geolocation |
| `device_type` | ENUM('mobile', 'desktop', 'tablet', 'bot', 'unknown') | |
| `browser` | VARCHAR(50) | Parsed from User-Agent |
| `os` | VARCHAR(50) | Parsed from User-Agent |
| `referrer_domain` | VARCHAR(255) | Normalized referrer domain only (not full URL — path may contain sensitive data) |
| `is_unique` | BOOLEAN | True if this is the first click from this ip_hash for this url_id today |

**The scale problem:** At 115K redirects/second, writing one row per click synchronously is impossible. This table is written **only by background workers processing the analytics queue**, not by the redirect handler directly. The redirect handler publishes an event to a queue and returns 302 immediately.

**Partitioning strategy:** Partition this table by month (`PARTITION BY RANGE (clicked_at)`). Benefits: queries for "last 30 days" only scan two partitions, dropping old data means `DROP PARTITION` (instant) instead of a `DELETE` across millions of rows.

---

#### Daily Analytics Aggregates Table

| Column | Type | Purpose |
|---|---|---|
| `url_id` | BIGINT | FK → URLs |
| `date` | DATE | Aggregation date |
| `total_clicks` | INTEGER | |
| `unique_clicks` | INTEGER | |
| `top_countries` | JSONB | `{"IN": 450, "US": 230}` |
| `top_referrers` | JSONB | `{"twitter.com": 120}` |
| `device_breakdown` | JSONB | |

**Why this exists:** Querying raw `click_events` for "last 30 days analytics" across 10 million clicks is expensive. A daily aggregation job (runs at 00:05 UTC) pre-computes these summaries. Analytics queries hit this table, not the raw events table. This is a classic **CQRS** (Command Query Responsibility Segregation) pattern — write raw events, read from aggregates.

---

### Relationship Summary

```
Users 1──∞ URLs
Users 1──∞ Refresh_Tokens
URLs  1──∞ Click_Events
URLs  1──∞ Daily_Analytics_Aggregates
```

---

### Handling High Write Load (Click Events)

The click events path goes: **Redirect Handler → Message Queue → Worker → Database**

The queue (BullMQ on Valkey) acts as a buffer. The database receives writes at the rate the worker can process them, not at the rate users click. You can scale workers independently of the web server. If the queue backs up, workers catch up — the user experience (redirect speed) is never affected.

---

### Handling Read-Heavy Redirection

Three-tier lookup:
1. **L1 — Application cache:** In-memory LRU cache (using `lru-cache` npm package) holding the 10,000 most-recently-accessed short codes. Zero network hop. Invalidated when a URL is updated/deleted.
2. **L2 — Valkey:** Shared cache across all server instances. Cache-aside pattern. TTL = 24 hours (refreshed on access). Handles the vast majority of traffic.
3. **L3 — PostgreSQL:** Only hit on cache miss. Read replica for redirects (primary only for writes).

At steady state, 95%+ of redirects are served from L1 or L2. The database handles only cold cache traffic.

---

### Handling Expiry

Three-mechanism approach:
1. **Lazy check at redirect time:** If `expires_at < NOW()`, return 410 immediately. No stale redirects ever.
2. **Eager TTL in Valkey:** When caching a URL, set Valkey TTL = `min(URL expiry, 24 hours)`. Expired URLs auto-evict from cache.
3. **Background cleanup job:** Runs nightly. Soft-deletes (sets `is_deleted = true`) all URLs where `expires_at < NOW()`. Removes them from active indexes.

---

## 5. System Architecture

### Component Diagram

```
                          ┌─────────────────────────────────────────┐
                          │           Load Balancer (Nginx/ALB)      │
                          │         TLS Termination, Rate Limiting   │
                          └──────────────┬──────────────────────────┘
                                         │
                     ┌───────────────────┴───────────────────────┐
                     │                                           │
             ┌───────▼────────┐                       ┌─────────▼────────┐
             │  API Servers   │                       │  Redirect Servers │
             │ (Auth, CRUD,   │                       │  (GET /:shortCode)│
             │  Analytics)    │                       │  Read-only path   │
             │  3-5 instances │                       │  5-10 instances   │
             └───────┬────────┘                       └────────┬─────────┘
                     │                                          │
          ┌──────────▼──────────────────────────────────────────▼──────┐
          │                    Valkey Cluster                           │
          │   Short Code Cache (L2) | Rate Limit Counters | Job Queues │
          └───────────┬──────────────────────────────────────┬─────────┘
                      │                                       │
            ┌─────────▼─────────┐                 ┌──────────▼────────┐
            │  PostgreSQL       │                 │   Analytics Queue  │
            │  Primary (writes) │                 │   (BullMQ Worker)  │
            │  Read Replica ×2  │                 │   Batch insert     │
            │  (reads)          │                 │   click events     │
            └───────────────────┘                 └────────────────────┘
                                                           │
                                                  ┌────────▼──────────┐
                                                  │  Click Events DB   │
                                                  │  (PostgreSQL with  │
                                                  │  monthly partitions│
                                                  │  or ClickHouse)    │
                                                  └────────────────────┘
```

### Why Separate API and Redirect Servers?

The redirect path has completely different characteristics from the management API:
- No auth overhead
- Extremely hot read path (mostly served from cache)
- Needs the lowest possible latency
- Traffic spikes are sudden (viral content)

Separating them lets you scale redirect servers independently, apply different resource profiles (more memory for caching on redirect servers), and ensures a CPU-intensive analytics export never competes with a latency-sensitive redirect.

---

### URL Generation Strategy

This is the most technically interesting part to an interviewer. Three approaches:

#### Approach 1: MD5/SHA256 Hash of Original URL
Take the long URL, hash it, take the first 7 characters.

**Problem:** Collision probability. Two different URLs could produce the same 7-character prefix. Collision handling requires a re-hash (e.g., append a counter suffix and re-hash). Also, the same original URL always produces the same short code — which means you can't create two separate tracked links to the same destination.

**Verdict:** Simple but collision-prone. Not production-standard.

#### Approach 2: Random UUID / Random String Generation
Generate a random 7-character alphanumeric string, check the database for uniqueness, retry if collision.

**Problem:** At high scale, as the namespace fills up, collision probability increases. Each creation might require multiple database round-trips. The birthday paradox works against you: with 3.5 trillion possible 7-character Base62 strings, collisions become frequent once you've used ~1% of the namespace (~35 billion URLs). But you'll never reach that scale without sharding anyway.

**Verdict:** Works well for moderate scale. The uniqueness check DB round-trip is the cost.

#### Approach 3: Distributed Counter + Base62 Encoding (Recommended)
Use an auto-incrementing integer ID (your `BIGSERIAL` primary key). Encode it in Base62.

- `1` → `"1"`
- `100` → `"1C"`
- `1,000,000` → `"4c92"`
- `56,800,235,584` → `"7chars"`

**Why Base62:** Digits (0-9) + lowercase (a-z) + uppercase (A-Z) = 62 characters. URL-safe. 7 characters = 62^7 = 3.5 trillion combinations. Enough for any realistic scale.

**The problem:** Sequential encoding is predictable. An attacker can enumerate `1, 2, 3...` and discover all short codes. Also, a single database is a bottleneck for generating unique IDs.

**Solution for enumeration:** Use a separate, shuffled mapping table (bijective encoding — a fixed permutation of Base62 characters). Or add a random component to the encoding. The ID is still unique and monotonic; it just doesn't *look* sequential.

**Solution for bottleneck:** Use a distributed ID generator like **Twitter Snowflake** or **Instagram's approach** — IDs embed a timestamp, datacenter ID, and sequence number. No central coordinator required.

**Verdict:** This is the production approach. Predictable storage, no collision probability, scalable ID generation.

---

### Caching Strategy

#### Cache-Aside Pattern (Lazy Loading)

On redirect request:
1. Check Valkey for `shortCode`
2. **Hit:** Return the `originalUrl` immediately. Update TTL (refresh expiry).
3. **Miss:** Query PostgreSQL. If found, write to Valkey with 24h TTL. Return `originalUrl`.

**Why not write-through (write to cache and DB simultaneously on creation)?**
Because you'd cache every URL created, including ones that never get clicked. Cache-aside only caches URLs that are actually accessed. Given the **power-law distribution** of URL traffic (a small number of URLs get most of the clicks), cache-aside naturally produces a hot-data cache with minimal waste.

#### Cache Invalidation

The hardest problem in computer science, as the saying goes. Your two invalidation scenarios:

1. **URL updated (original destination changes):** On `PATCH /api/v1/urls/:shortCode`, immediately `DEL` the Valkey key for that shortCode. Next redirect will re-fetch from DB and re-cache the updated value.

2. **URL deleted or disabled:** Same — `DEL` the Valkey key. But also set a negative cache entry (`shortCode → "DELETED"`) with a short TTL (30 seconds) to prevent a thundering herd of DB lookups for a deleted URL that's still being accessed.

#### L1 (In-Process) Cache Invalidation

The in-memory LRU cache cannot be explicitly invalidated across multiple server instances without a pub/sub mechanism. The pragmatic approach: short TTL (30-60 seconds) on L1 cache entries. Stale data window is bounded. For a URL shortener, a 60-second window where a deleted URL still redirects is an acceptable trade-off over the complexity of cross-instance cache invalidation.

---

### Scaling Strategy

#### Horizontal Scaling

Add more server instances behind the load balancer. This works because:
- The application is stateless (no in-process sessions)
- All state lives in Valkey and PostgreSQL, which are shared

The load balancer uses **consistent hashing** to route requests, or simply round-robin (simpler, fine for stateless services).

#### Database Read Scaling

Add PostgreSQL read replicas. Direct all read queries (redirect lookups, analytics reads) to replicas. Only writes go to the primary.

Replication lag is the concern — there's a window (typically <1 second) where a freshly created URL might not appear on a replica. For the redirect path, this is fine (Valkey caches it on creation anyway). For "get my URLs" list, the user might not see a just-created URL for a moment — acceptable.

#### Database Write Scaling (When Needed)

When write throughput on URLs table exceeds what a single primary can handle:

**Vertical scaling:** Bigger machine. Usually sufficient for URL creation (remember — writes are 1x; most traffic is reads).

**Sharding by `user_id`:** All of a user's URLs live on the same shard. Queries that filter by `user_id` hit one shard. Works well until a single user has billions of URLs (rare).

**Sharding by `short_code` prefix:** First character determines the shard. But this doesn't help with user-specific queries.

The honest answer for a URL shortener: you probably never need to shard the URLs table if you partition click_events and offload analytics to a separate store.

---

## 6. URL Generation Strategy

### Base62 Encoding — The Algorithm (Conceptual)

Base62 is just a numeral system with 62 digits instead of 10.

1. Take the integer ID: e.g., `12345678`
2. Repeatedly divide by 62, collect remainders
3. Map each remainder to a character in your alphabet: `0-9` → `'0'-'9'`, `10-35` → `'a'-'z'`, `36-61` → `'A'-'Z'`
4. Reverse the collected characters

**This is a classic DSA problem** (number base conversion). You're building a live system where you can point to the Base62 encoder and say "this is Base62 encoding, here's the algorithm I implemented, here's why I chose 7 characters, here's the collision math." That's an impressive interview moment.

### Collision Handling

With the counter approach, there are **no collisions by definition** — every integer is unique, and the encoding is bijective (one-to-one mapping). Collision only becomes a concern if:
- You allow custom aliases (which go in the same `short_code` column): check for uniqueness before insertion, return conflict error if taken
- Multiple counter shards in a distributed system generate the same counter value: use Snowflake IDs which embed instance ID to guarantee global uniqueness

---

## 7. Day-by-Day Execution Plan

> **Philosophy:** Each day ends with something that runs and can be shown. No days that are "just planning" or "just reading docs."

### Week 1 — Foundation & Core

#### Day 1 — Environment + Database
**Build:** Docker Compose with PostgreSQL + Valkey running. Prisma schema for Users and URLs tables. `prisma migrate dev` executed. Tables verified in `psql`.

**Concept:** PostgreSQL index types — B-tree vs. Hash. Understand why `short_code` gets a B-tree unique index, not a Hash index, despite Hash being faster for equality lookups (answer: B-tree supports range queries and ORDER BY; PostgreSQL's Hash indexes aren't write-ahead logged before Postgres 10).

**Outcome:** You can connect to Postgres, see your tables, and query them.

---

#### Day 2 — Auth Foundations
**Build:** `POST /api/v1/auth/register` and `POST /api/v1/auth/login` endpoints. Argon2id password hashing. JWT generation. Refresh token stored in DB.

**Concept:** Why Argon2id beats bcrypt — memory-hardness parameter prevents GPU-based brute force. Understand the difference between access token (stateless, short-lived) and refresh token (stored, revocable, long-lived).

**Outcome:** You can register a user, log in, receive both tokens, verify the password hash in the database.

---

#### Day 3 — URL Creation
**Build:** `POST /api/v1/urls` with JWT auth middleware. Base62 encoding utility using the BIGSERIAL id. Write to DB.

**Concept:** Implement Base62 from scratch without a library. Understand why BIGSERIAL is used as the encoding input rather than a UUID (UUIDs are 128-bit; Base62 encoding a UUID produces a 22-character string — too long).

**Outcome:** Authenticated user can create a short URL and receive a `shortUrl` back.

---

#### Day 4 — Redirect Endpoint
**Build:** `GET /:shortCode` → 302 redirect. Direct database lookup (no cache yet).

**Concept:** HTTP redirect codes — 301 vs 302 vs 307 vs 308. Why you choose 302 here. What happens in the browser for each type.

**Outcome:** Visiting `localhost:3000/abc123` in a browser redirects you to the original URL.

---

#### Day 5 — Valkey Caching Layer
**Build:** Cache-aside pattern for the redirect endpoint. Valkey get → if miss, DB query → Valkey set with 24h TTL. Cache invalidation on URL update/delete.

**Concept:** Cache-aside vs write-through vs write-behind. The thundering herd problem — what happens when a cached item expires and 10,000 requests arrive simultaneously for that key? How to mitigate with probabilistic early expiry.

**Outcome:** Second redirect for the same short code never hits the database. Verify with query count logging.

---

#### Day 6 — Rate Limiting
**Build:** Token bucket rate limiting middleware using Valkey. Two limits: per-IP on the redirect endpoint (anti-bot), per-user-JWT on the creation endpoint.

**Concept:** Token Bucket vs Sliding Window Log vs Fixed Window Counter algorithms. Why Token Bucket is preferred (allows bursts, smooth throttling). Why you can't implement this in-process in a distributed system.

**Outcome:** Creating more than 10 URLs/minute with the same JWT returns 429. Verify the Valkey counter keys are being set.

---

#### Day 7 — Async Analytics Pipeline
**Build:** BullMQ job queue. Redirect endpoint publishes click event to queue (non-blocking). Separate worker process consumes events, parses User-Agent, calls free IP geolocation API, writes to Click Events table.

**Concept:** The producer-consumer pattern. Why the queue is a buffer (decouples write rate from processing rate). What happens to queued jobs if the worker crashes — job persistence in Valkey, retry with exponential backoff, dead-letter queue.

**Outcome:** Every redirect generates a click event in the database, but redirect latency is unaffected. Verify by timing redirects with and without the queue (`curl -w "%{time_total}"`).

---

### Week 2 — Production Hardening

#### Day 8 — Input Validation + Security Hardening
**Build:** Zod schema validation on all request bodies. `helmet` middleware for security headers (CSP, X-Frame-Options, HSTS). CORS configuration. Ownership-scoped queries (IDOR prevention — all `WHERE` clauses include `AND user_id = ?`).

**Concept:** Defense in depth for input handling. The difference between validation (is this input well-formed?) and sanitization (make this input safe). Why you never trust `req.body` without a schema. URL validation edge cases — data URIs (`data:text/html,...`), `javascript:` pseudo-URLs, localhost URLs.

**Outcome:** Submitting `{"originalUrl": "javascript:alert(1)"}` returns a 422 validation error. Security headers visible in response headers.

---

#### Day 9 — Analytics Routes + Aggregation
**Build:** `GET /api/v1/urls/:shortCode/analytics/summary` using Click Events table. A script that runs aggregation and writes to Daily Aggregates table.

**Concept:** Denormalized counters (`click_count` on URLs table) vs aggregation queries vs pre-computed aggregates. The CAP theorem applied to analytics — is it acceptable for analytics to be slightly stale? (Yes — eventual consistency is fine for non-financial data.)

**Outcome:** Analytics endpoint returns click counts, top referrers, and country breakdown for a URL.

---

#### Day 10 — Graceful Shutdown + Error Handling
**Build:** `SIGTERM`/`SIGINT` handler that stops accepting new connections, drains in-flight requests, closes DB connection pool, gracefully shuts down BullMQ workers. Centralized error handler with structured error responses.

**Concept:** Why graceful shutdown matters in containerized environments (Kubernetes sends SIGTERM before killing a pod — a 30-second window to finish in-flight work). The difference between operational errors (expected — invalid input, 404) and programmer errors (unexpected — unhandled promise rejection, TypeError). Each is handled differently.

**Outcome:** `Ctrl+C` causes the server to log "Draining connections... Closing DB pool... Shutdown complete." In-flight requests finish; new connections are rejected.

---

#### Day 11 — Link Expiry + Background Jobs
**Build:** Scheduled cleanup job (runs via BullMQ's repeatable jobs, every hour) that soft-deletes expired URLs. Lazy expiry check in the redirect handler. 410 response for expired/deleted URLs.

**Concept:** Cron-based vs event-driven scheduling. The difference between idempotent jobs (safe to run multiple times — your cleanup job is idempotent because re-processing an already-deleted URL is a no-op) and non-idempotent jobs (dangerous to double-run).

**Outcome:** Create a URL with `expiresAt` = 2 minutes from now. Redirect works initially. After 2 minutes, redirect returns 410.

---

#### Day 12 — Structured Logging + Observability
**Build:** Pino structured JSON logging with `LOG_LEVEL=debug` in dev (pretty-printed via `pino-pretty`), `LOG_LEVEL=info` in prod. Request ID propagated through all log entries for a single request. Log correlation: you can grep by `requestId` to see every log entry for one HTTP request.

**Concept:** Why structured logs (JSON) beat unstructured logs (string concatenation) — machine parseable, filterable, searchable. The log levels hierarchy (`debug < info < warn < error < fatal`) and when to use each. What NOT to log — PII (email addresses, IPs in raw form), secrets, full request bodies.

**Outcome:** Every request produces a single log line with `requestId`, `method`, `path`, `statusCode`, `duration_ms`, `userId`. You can `grep "4c92"` to find all log lines for short code `4c92`.

---

#### Day 13 — Deployment to AWS EC2
**Build:** EC2 t3.micro (free tier), PM2 for process management and auto-restart, Nginx as reverse proxy (handles TLS, compression, rate limiting at the network layer before reaching Node.js). Environment variables via `.env` file (not committed to repo).

**Concept:** Why PM2 in front of Node.js (single-threaded event loop — PM2 cluster mode spawns one process per CPU core). Why Nginx in front of PM2 (TLS termination is expensive — better at Nginx with native C code than Node.js. Also handles static assets, compression). The difference between `pm2 start` and `pm2 start --watch` (never use `--watch` in production).

**Outcome:** Live URL: `http://your-ec2-ip/abc123` redirects successfully. PM2 shows process uptime.

---

#### Day 14 — Polish + Documentation
**Build:** README with architecture diagram (draw it in Excalidraw, export as PNG). `.env.example` with all required variables documented. Postman collection or Bruno collection for all API endpoints. OpenAPI/Swagger docs auto-generated.

**Concept:** What "production-ready" actually means. The checklist: no hardcoded secrets, structured logging, graceful shutdown, health check endpoint, documented API, dependency versions pinned.

**Outcome:** A stranger can clone your repo, run `docker-compose up -d` + `npm install` + `npm run dev`, and have the system working in under 5 minutes. This is your README's test.

---

## 8. Edge Cases & Failure Handling

### Duplicate URLs

**Scenario:** User shortens the same long URL twice.

**Decision:** Allow it — create two distinct short codes pointing to the same original URL. This is the correct behavior because:
- The user might want separate analytics for two different campaigns pointing to the same page
- Enforcing uniqueness requires a lookup on `originalUrl`, which is an expensive query on a large text column (text hashing to index it adds complexity)
- Bitly allows this

**Optional optimization:** If you want to offer "you already have a short link for this URL," do a `SELECT WHERE originalUrl = ? AND userId = ?` and return the existing entry with a `409 Conflict` + the existing short URL, giving the user the choice to use the existing one or create a new one.

---

### Link Expiration Race Condition

**Scenario:** URL expires at 12:00:00. Two requests arrive at 11:59:59 and 12:00:01 milliseconds apart.

**Handling:** The lazy check in the redirect handler uses `NOW()` from the database/application time at request processing time. The request at 11:59:59 gets a valid redirect. The request at 12:00:01 gets 410. There's no race condition — the check is a simple timestamp comparison, not a state transition.

The only edge case: cached entries in Valkey. If the URL expired at 12:00:00 but is cached with a 24h TTL, requests after expiry would still serve the redirect for up to 24 hours. **Solution:** When caching a URL, set Valkey TTL = `min(URL remaining TTL, 24 hours)`. This way, the cache entry expires when (or before) the URL expires.

---

### Abuse and Spam Prevention

**Malicious URL Shortening:**
- Check against Google Safe Browsing API on creation (async — don't block the response)
- If flagged, set `is_flagged = true`, return 451 on redirect
- Pattern detection: same user shortening 100 URLs to the same domain in 5 minutes is suspicious

**Enumeration Attacks:**
- Don't use sequential short codes that reveal total URL count
- Use shuffled Base62 encoding so codes don't look sequential
- Rate limit unauthenticated requests to `GET /:shortCode` aggressively (10/min per IP)

**Inflated Click Analytics:**
- A user could write a script to click their own short URL millions of times to inflate analytics (for vanity or to abuse a "most popular" feature)
- Bot detection: `is_unique` flag using hashed IP + daily salt. Multiple clicks from the same IP on the same day count as 1 unique click
- User-Agent analysis: requests with missing/bot User-Agents are flagged, not counted as unique

---

### Rate Limiting Failures

**Scenario:** Valkey is down. The rate limiter can't check or update counters.

**Decision:** Fail open — allow the request. The alternative (fail closed — reject all requests when Valkey is down) means a Valkey outage causes a complete service outage. For a URL shortener, brief rate limit bypass during Valkey downtime is an acceptable trade-off.

**Circuit breaker pattern:** Track Valkey failure rate. If Valkey is failing >50% of the time for 30 seconds, open the circuit (skip Valkey checks entirely, use in-memory fallback limits). Half-open after 60 seconds to probe recovery.

---

### Database Primary Failure

**Scenario:** PostgreSQL primary goes down.

**With read replicas configured:**
- Reads continue via replicas (redirects continue working — they use the cache + replicas)
- Writes fail (URL creation, analytics updates)
- User-visible impact: "create short URL" returns 503. Redirects continue working.

**Recovery:** PostgreSQL replica promotion (manual or automated via Patroni/RDS Multi-AZ). Time to recovery: seconds (automated) to minutes (manual).

**Key insight:** The most business-critical path (redirection) is the most resilient (served from cache + read replicas). The less-critical paths (creation, management) fail gracefully with 503.

---

### Cache Stampede (Thundering Herd)

**Scenario:** A cached short code for a viral URL expires. 50,000 concurrent requests arrive for the same code and all get a cache miss simultaneously. 50,000 database queries execute at once.

**Solutions:**
1. **Probabilistic Early Expiry (PER):** Before a cache entry expires, recompute it with a small random probability on each access. Popular items get their cache refreshed before they expire, so the stampede never happens.

2. **Cache Mutex / Locking:** The first request to get a cache miss acquires a Valkey lock, fetches from DB, and repopulates the cache. All other concurrent requests wait for the lock and then get the cache hit.

3. **Stale-while-revalidate:** Serve the stale cached value immediately (user gets the redirect), and asynchronously refresh the cache in the background. The user never waits; the cache is refreshed without a stampede.

---

## 9. Performance & Optimization

### Reducing Redirect Latency

The target: p99 redirect latency under 10ms.

**Audit the critical path:**

| Step | Latency | Optimization |
|---|---|---|
| TLS handshake | 0ms (connection reuse, TLS session resumption) | Keep-Alive, HTTP/2 |
| Network (client → server) | Variable | CDN edge caching |
| Nginx proxy overhead | ~1ms | Minimal — just header forwarding |
| L1 in-process cache hit | ~0.1ms | LRU cache for hot codes |
| L2 Valkey lookup | ~1ms (same datacenter) | Valkey pipelining, connection pooling |
| PostgreSQL query | ~2-5ms | Only on cache miss; indexed lookup |
| User-Agent parsing | ~0ms (async, not on critical path) | |

At steady state: a redirect served from L2 Valkey cache takes ~2ms total (network + proxy + Valkey). A cold cache redirect (DB query) takes ~7-10ms. Well within the 10ms target.

### Read vs. Write Optimization

**Read path is already covered.** The write path (URL creation) has different concerns:

- URL creation is ~1 write/second — a completely different scale problem
- The bottleneck on write path is the uniqueness check for custom aliases: this is a DB round-trip. Mitigate by checking the in-memory cache first (if the code is cached, it definitely exists)
- Batch insertions (for the analytics pipeline): use `INSERT INTO ... VALUES (batch)` rather than individual inserts. 1 insert of 1,000 rows is 100x faster than 1,000 individual inserts

### Analytics Query Optimization

**Without pre-aggregation:** `SELECT COUNT(*), country FROM click_events WHERE url_id = ? AND clicked_at > NOW() - INTERVAL '30 days' GROUP BY country` scans potentially millions of rows.

**With daily aggregates table:** Query 30 rows in the `daily_analytics_aggregates` table. Sub-millisecond.

**Trade-off:** Aggregation job runs nightly. Analytics data is stale by up to 24 hours. For a real-time dashboard, maintain a rolling counter in Valkey (increment `clicks:{shortCode}:{date}` on every click). Use Valkey counter for "today's" analytics, daily aggregates for historical.

### Cache Invalidation Strategy (Summary)

| Trigger | Action |
|---|---|
| URL created | No cache write (cache-aside: write only on first access) |
| URL redirected (cache miss) | Write to Valkey with TTL = min(URL remaining TTL, 24h) |
| URL updated | `DEL` Valkey key. L1 TTL auto-expires within 60s. |
| URL deleted | `DEL` Valkey key. Write negative entry (`DELETED`) with 30s TTL. |
| URL expired | Valkey TTL handles it (set correctly on cache write). |

---

## 10. Interview Perspective

### How to Present This Project

**Wrong way:** "I built a URL shortener. It uses Node.js, Postgres, and Redis. You can create short links and track clicks."

This sounds like you followed a tutorial.

**Right way:** Lead with decisions and trade-offs.

> "I built a URL shortener at Bitly scale. The most interesting design decision was the redirect pipeline. The redirect endpoint has to be under 10ms at p99, but I also need to record analytics for every click. If I wrote to the database synchronously in the redirect handler, I'd add 5-10ms of DB latency to every click. So I separated them: the redirect handler publishes a click event to a BullMQ queue and returns the 302 immediately, then a worker consumes from the queue and writes analytics asynchronously. The user never feels the analytics write. The trade-off is eventual consistency in analytics — click counts are slightly stale. I decided that was acceptable because analytics aren't financial data."

**Then invite follow-up:**
> "I also had to decide between 301 and 302 redirects. 301 is cached by browsers, which would mean I lose analytics for repeat visitors. 302 forces every click through my server. I chose 302 for analytics-enabled links and documented that trade-off in the README."

---

### Key Design Decisions to Highlight

These are the decisions that show systems thinking, not just coding:

1. **Counter + Base62 vs. random codes** — You understand the enumeration risk, the birthday paradox, and the trade-off between predictability and security. Explain the shuffled encoding as a mitigation.

2. **Async analytics pipeline** — The most sophisticated pattern in the project. Show that you understand why synchronous analytics would kill redirect latency.

3. **Cache-aside vs. write-through** — Why cache-aside is better for power-law traffic distributions. Most cached items are "hot" (frequently accessed), so lazy loading ensures you only cache what's actually needed.

4. **IDOR prevention via ownership-scoped queries** — This is a security decision most junior engineers miss. Emphasize that you return 404 (not 403) for unauthorized access, citing the information leakage principle.

5. **Graceful shutdown** — Many engineers can't explain this. Being able to say "my server listens for SIGTERM, drains in-flight requests, then closes the DB pool — this is required in Kubernetes environments where pods can be evicted at any time" demonstrates production awareness.

6. **Soft delete vs. hard delete** — Explain that hard deletion loses analytics history. Soft deletion with `is_deleted = true` preserves history while the URL is effectively gone from the redirect path.

---

### Questions You Should Be Able to Answer

These are the questions interviewers ask to distinguish people who understand their system from people who just built it:

- *"What breaks first as traffic scales?"* — The database read replicas before the cache, but only on cache miss traffic. The click events queue first if workers can't keep up.

- *"How would you handle 1 million concurrent redirects?"* — Horizontal scale the redirect servers. The stateless design means adding instances is trivial. The bottleneck becomes Valkey, which you can cluster. PostgreSQL only sees cache miss traffic.

- *"What's your RTO and RPO?"* — RTO (Recovery Time Objective): redirects continue via cache even if the DB is down (RPO is effectively zero for the redirect path). URL creation has an RTO of minutes (DB failover). RPO (Recovery Point Objective): with synchronous replication to a replica, zero data loss.

- *"How would you add custom domains?"* — DNS CNAME verification, per-tenant routing at the load balancer, TLS cert provisioning via Let's Encrypt ACME, and tenant context extracted from the `Host` header in the redirect handler. That's the 60-second answer; implementation is weeks of work.

- *"Why not use DynamoDB instead of PostgreSQL?"* — For the URLs table: PostgreSQL gives you ACID, foreign keys, and efficient joins for analytics. The write load on URLs is low (1x). For click events: DynamoDB would be excellent — high write throughput, no schema changes needed. A hybrid approach (PostgreSQL for URLs + DynamoDB or ClickHouse for click events) is the mature answer.

---

## Appendix: Configuration Reference

### Environment Variables (`.env`)
```
# Secrets (never in yaml, never in repo)
DATABASE_URL=postgresql://...
VALKEY_URL=redis://localhost:6379
JWT_SECRET=<256-bit random hex>
JWT_REFRESH_SECRET=<different 256-bit random hex>
IP_GEO_API_KEY=<free tier key>

# Non-secret config (can live in yaml for non-sensitive envs)
PORT=3000
LOG_LEVEL=debug
NODE_ENV=development
BASE_URL=http://localhost:3000
JWT_ACCESS_EXPIRY=900
JWT_REFRESH_EXPIRY=2592000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=10
DB_POOL_SIZE=5
CACHE_TTL_SECONDS=86400
```

### `.env.production` additions
```
LOG_LEVEL=info
NODE_ENV=production
DB_POOL_SIZE=20
```

---

*Last updated: This document is a living guide — update it as your implementation evolves. The README of your project should reference this document and highlight which trade-offs you made and why.*
