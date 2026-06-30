# Section 4: Database Design — Hinglish Mein

---

## **SQL vs NoSQL — Kaun Choose Karu?**

### **When to Choose SQL (PostgreSQL)?**

**Jab data ke relationships clear ho:**
- User owns URLs
- URLs have many Clicks
- Clicks have analytics

**Jab ACID guarantee chahiye:**
- URL create + initial analytics atomically
- Ek saath ho ya kuch nahi

**Jab complex queries chahiye:**
- Analytics: Join URLs + Click_Events + Daily_Aggregates
- SQL joins easy

**Jab schema enforcement chahiye:**
- Type safety at database level
- Prevent garbage data

### **When NoSQL Might Work?**

Click Events table:
- Extremely high write volume (115K/sec)
- Append-only (no updates)
- No relational complexity

**Answer:** Start with PostgreSQL everywhere. Migrate click events to ClickHouse (columnar store) when performance degrades. Don't over-engineer upfront! ✅

---

## **Schema Design — Tables**

### **1️⃣ Users Table**

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,  -- Argon2id hash
  name VARCHAR(100),
  plan ENUM('free', 'pro', 'enterprise') DEFAULT 'free',
  is_verified BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX idx_users_email ON users(email);
```

**Columns Explanation:**

| Column | Type | Kyu |
|---|---|---|
| `id` | UUID | UUID se ID enumeration nahi kar sakte |
| `email` | VARCHAR(255) | Login identifier, unique |
| `password_hash` | VARCHAR(255) | Argon2id hash (never plaintext!) |
| `name` | VARCHAR(100) | Display name |
| `plan` | ENUM | Feature gating (free/pro/enterprise) |
| `is_verified` | BOOLEAN | Email verification gate |
| `is_active` | BOOLEAN | Soft disable without deletion |
| `created_at` | TIMESTAMPTZ | UTC timestamp |
| `updated_at` | TIMESTAMPTZ | Auto-update on every change |

---

### **2️⃣ Refresh Tokens Table**

```sql
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  token_hash VARCHAR(64) NOT NULL,  -- SHA-256 hash (never store raw!)
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,  -- NULL = active
  user_agent VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
```

**Kyu separate table?**

```
Benefit 1: List active sessions
  SELECT * FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL

Benefit 2: Revoke specific device
  UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?

Benefit 3: Token theft detection
  Compare user_agent → different device = suspicious!
```

---

### **3️⃣ URLs Table**

```sql
CREATE TABLE urls (
  id BIGSERIAL PRIMARY KEY,  -- Used for Base62 encoding
  short_code VARCHAR(12) NOT NULL UNIQUE,  -- Generated or custom
  original_url TEXT NOT NULL,  -- TEXT not VARCHAR (URLs can be long)
  user_id UUID REFERENCES users(id),  -- NULL for anonymous links
  custom_alias VARCHAR(50),
  expires_at TIMESTAMPTZ,  -- NULL = never expires
  click_count BIGINT DEFAULT 0,  -- Denormalized counter
  is_active BOOLEAN DEFAULT true,
  is_deleted BOOLEAN DEFAULT false,  -- Soft delete
  is_flagged BOOLEAN DEFAULT false,  -- Malicious URL flag
  tags TEXT[],  -- PostgreSQL array
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes (Critical!)
CREATE UNIQUE INDEX idx_urls_short_code ON urls(short_code);
CREATE INDEX idx_urls_user_id ON urls(user_id);
CREATE INDEX idx_urls_expires_at ON urls(expires_at) 
  WHERE expires_at IS NOT NULL AND expires_at < NOW();
CREATE INDEX idx_urls_user_created ON urls(user_id, created_at DESC);
```

**Key Design Decision:**
```
Separate id (BIGSERIAL) and short_code (VARCHAR)?

id = Input for Base62 encoding
short_code = Result of encoding

Why separate?
- If encoding algorithm changes, regenerate short_code
- Custom aliases stored in same column with no integer relationship
```

**Indexes Explanation:**

| Index | Purpose | Impact |
|---|---|---|
| `idx_urls_short_code` | MOST CRITICAL! Every redirect does: SELECT WHERE short_code = ? | Sub-millisecond lookup |
| `idx_urls_user_id` | List all URLs for a user: SELECT WHERE user_id = ? | Pagination queries |
| `idx_urls_expires_at` | Background job: DELETE WHERE expires_at < NOW() | Partial index = efficient |
| `idx_urls_user_created` | Composite index for: SELECT WHERE user_id = ? ORDER BY created_at DESC | Pagination sorted |

---

### **4️⃣ Click Events Table**

```sql
CREATE TABLE click_events (
  id BIGSERIAL PRIMARY KEY,
  url_id BIGINT NOT NULL REFERENCES urls(id),
  clicked_at TIMESTAMPTZ NOT NULL,
  ip_hash VARCHAR(64) NOT NULL,  -- SHA-256(IP + daily_salt)
  country_code CHAR(2),  -- ISO code
  city VARCHAR(100),
  device_type ENUM('mobile', 'desktop', 'tablet', 'bot', 'unknown'),
  browser VARCHAR(50),
  os VARCHAR(50),
  referrer_domain VARCHAR(255),  -- Domain only (no path!)
  is_unique BOOLEAN,  -- First click from this IP today?
  created_at TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY RANGE (clicked_at) (
  PARTITION p_2026_01 VALUES FROM ('2026-01-01') TO ('2026-02-01'),
  PARTITION p_2026_02 VALUES FROM ('2026-02-01') TO ('2026-03-01'),
  -- ... etc
);
```

**Why Partitioning by Month?**

```
Problem: 10B clicks/day × 500 bytes = 5TB/day
After 1 year = 1.8 PB! 😱

Solution: Monthly partitions

SELECT ... WHERE clicked_at > NOW() - INTERVAL '30 days'
→ Scans only 2 partitions (current + previous)

DELETE old data:
DROP PARTITION p_2025_01
→ Instant! vs DELETE across 30B rows (slow!)
```

**Privacy Note:**
```
❌ Never store raw IP:
   ip: "203.0.113.45"  ← GDPR violation!

✅ Store hashed IP:
   ip_hash: "sha256(203.0.113.45 + daily_salt)"
   
Why daily salt?
- Hash rotates every 24h
- Same-day unique detection: same hash = same user
- Long-term tracking impossible: different hashes each day
```

---

### **5️⃣ Daily Analytics Aggregates Table**

```sql
CREATE TABLE daily_analytics_aggregates (
  url_id BIGINT NOT NULL REFERENCES urls(id),
  date DATE NOT NULL,
  total_clicks INTEGER,
  unique_clicks INTEGER,
  top_countries JSONB,  -- {"IN": 5000, "US": 2000}
  top_referrers JSONB,  -- {"twitter.com": 3000, "direct": 2000}
  device_breakdown JSONB,  -- {"mobile": 70, "desktop": 30}
  PRIMARY KEY (url_id, date)
);

-- Indexes
CREATE INDEX idx_daily_agg_date ON daily_analytics_aggregates(date);
```

**Why This Table Exists?**

```
❌ Without aggregation:
Query: Analytics for last 30 days
SELECT COUNT(*), country FROM click_events 
WHERE url_id = ? AND clicked_at > NOW() - INTERVAL '30 days'
GROUP BY country
→ Scan 30B rows! 💀 SLOW!

✅ With aggregation:
Query: Same thing
SELECT top_countries FROM daily_analytics_aggregates
WHERE url_id = ? AND date >= NOW() - INTERVAL '30 days'
→ Scan 30 rows! 🚀 FAST!

Trade-off: 24 hour staleness acceptable
```

**CQRS Pattern:**
```
Write Path: Click → Analytics Queue → Worker → click_events table
Read Path: daily_analytics_aggregates table

Separate read/write paths!
```

---

## **Relationships Summary**

```
Users (1) ──→ (∞) URLs
Users (1) ──→ (∞) Refresh_Tokens
URLs (1) ──→ (∞) Click_Events
URLs (1) ──→ (∞) Daily_Analytics_Aggregates
```

---

## **Handling High Load — Three Strategies**

### **Strategy 1: Read-Heavy Redirection (Caching)**

```
Request: GET /:shortCode

L1 - In-Memory Cache (LRU):
  ✅ Hit → return immediately (0.1ms)
  ❌ Miss → go to L2

L2 - Valkey Cache:
  ✅ Hit → return immediately (1ms)
  ❌ Miss → go to L3

L3 - PostgreSQL (Read Replica):
  Query with indexed lookup (5ms)
  
At steady state: 95%+ served from L1 or L2!
```

**Cache-Aside Pattern Code Flow:**

```
1. Check Valkey: GET url:shortCode
2. Hit? → Return originalUrl
3. Miss? → Query DB: SELECT original_url WHERE short_code = ?
4. Found? → SET Valkey url:shortCode "originalUrl" EX 86400
5. Return originalUrl
```

---

### **Strategy 2: Write-Heavy Click Events (Queue)**

```
Request: GET /:shortCode → Redirect

WRONG (❌ Synchronous):
  1. Redirect
  2. Write to click_events (5-10ms wait!) ← User feels!
  3. Return

CORRECT (✅ Asynchronous):
  1. Publish to BullMQ queue (instant, non-blocking)
  2. Return redirect immediately
  3. Background worker consumes queue
  4. Worker writes to click_events
```

**Queue Acts as Buffer:**
```
User clicks at: 115,000/second
Database can write: 10,000/second

Queue buffers: 115,000 - 10,000 = 105,000 in queue
Worker catches up slowly

User experience: NEVER affected! ✅
Database receives manageable load ✅
```

---

### **Strategy 3: Expiry Handling (Lazy + Eager)**

```
URL expires at: 2026-04-20 23:59:59

Lazy Check (At Redirect Time):
  IF expires_at < NOW()
    RETURN 410 Gone
  Immediate response!

Eager TTL (In Valkey):
  SET url:shortCode "..." EX (remaining_ttl)
  Auto-evicts from cache at expiry

Eager Cleanup (Nightly Job):
  UPDATE urls SET is_deleted = true
  WHERE expires_at < NOW()
  Keeps storage clean
```

---

## **Denormalization vs Normalization**

### **click_count Column (Denormalized)**

```
❌ Normalized:
SELECT COUNT(*) FROM click_events WHERE url_id = ?
→ Expensive every time! Count 1B rows!

✅ Denormalized:
SELECT click_count FROM urls WHERE id = ?
→ Instant!

Trade-off: Update on every click
→ Solved via async aggregation job
```

**How It Works:**

```
1. User clicks → Event to queue (no DB write)
2. Background worker collects 1000 events
3. Batch update: UPDATE urls SET click_count = click_count + 1000
4. Single query handles 1000 clicks!
```

---

## **Index Strategy — Critical!**

### **Most Important Index: short_code**

```sql
CREATE UNIQUE INDEX idx_urls_short_code ON urls(short_code);
```

**Why?**
- Every redirect does: `SELECT * WHERE short_code = ?`
- 115,000 queries/second on this index!
- Without index: table scan (SLOW!)
- With index: direct lookup (FAST!)

**Type: B-Tree (not Hash)**

| Index Type | Equality | Range | Order By |
|---|---|---|---|
| B-Tree | ✅ Fast | ✅ Supported | ✅ Supported |
| Hash | ✅ Faster | ❌ No | ❌ No |

**Why B-Tree despite Hash being faster?**
- Range queries: `WHERE short_code > 'abc' AND short_code < 'xyz'`
- ORDER BY: `ORDER BY short_code DESC`
- B-Tree handles all!

---

## **Query Examples — What Actually Runs**

### **Example 1: Create URL**

```sql
INSERT INTO urls (id, short_code, original_url, user_id, created_at)
VALUES (DEFAULT, 'abc123', 'https://amazon.in/...', 'user-uuid', NOW())
RETURNING id, short_code, created_at;
```

**Indexes used:** UNIQUE constraint on short_code (prevent duplicates)

---

### **Example 2: Redirect (Highest Traffic)**

```sql
SELECT original_url, expires_at FROM urls
WHERE short_code = 'abc123'
  AND is_deleted = false
  AND is_active = true;
```

**Indexes used:** idx_urls_short_code (critical!)

**Query plan:**
```
Index Scan using idx_urls_short_code on urls
  Index Cond: (short_code = 'abc123')
  Filter: (is_deleted = false AND is_active = true)
→ Sub-millisecond!
```

---

### **Example 3: List User's URLs**

```sql
SELECT short_code, original_url, click_count, created_at
FROM urls
WHERE user_id = 'user-uuid'
  AND is_deleted = false
ORDER BY created_at DESC
LIMIT 20;
```

**Indexes used:** idx_urls_user_created (composite)

---

### **Example 4: Analytics Query**

```sql
SELECT country_code, COUNT(*) as clicks
FROM daily_analytics_aggregates
WHERE url_id = 123 AND date >= NOW() - INTERVAL '30 days'
GROUP BY country_code
ORDER BY clicks DESC;
```

**Indexes used:** None (only 30 rows!)

---

## **Connection Pooling**

```javascript
// DB pool size impacts performance

Development:
  DB_POOL_SIZE=5  // Few concurrent connections

Production:
  DB_POOL_SIZE=20  // More capacity
  
Why pooling?
- Each connection expensive (handshake, auth)
- Reuse connections across requests
- Limit total connections (prevent DB overload)
```

---

## **Section 4 Takeaway**

✅ **PostgreSQL chosen:** Relationships + ACID + complex queries

✅ **5 Tables designed:**
- Users (auth)
- Refresh Tokens (revocable)
- URLs (core data)
- Click Events (analytics)
- Daily Aggregates (pre-computed)

✅ **Indexes critical:**
- `short_code` = most important (every redirect!)
- Composite for pagination
- Partial for cleanup jobs

✅ **Caching + Queue handle scale:**
- L1+L2 cache for reads
- BullMQ queue for writes

✅ **Denormalization smart:**
- click_count avoids COUNT query
- Aggregates avoid scanning billions of rows

---

**Next:** Section 5 — System Architecture (Components + Scaling)
