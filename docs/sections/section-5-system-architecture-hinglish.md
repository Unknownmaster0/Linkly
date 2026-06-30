# Section 5: System Architecture — Hinglish Mein

---

## **Complete Architecture Diagram Samjho**

```
┌──────────────────────────────────────────────────┐
│     Users (Clients)                              │
│  (Browser, Mobile, API Clients)                  │
└────────────────┬─────────────────────────────────┘
                 │ HTTPS Traffic
                 ▼
┌──────────────────────────────────────────────────┐
│   Load Balancer (Nginx / AWS ALB)                │
│   - TLS Termination                              │
│   - Rate Limiting (DDoS Protection)              │
│   - Request Routing                              │
└────┬─────────────────────────────┬────────────────┘
     │                             │
     ▼                             ▼
┌─────────────────────┐    ┌──────────────────────┐
│  API Servers        │    │ Redirect Servers     │
│  (3-5 instances)    │    │ (5-10 instances)     │
│  - Auth             │    │ - GET /:shortCode    │
│  - URL CRUD         │    │ - Light processing   │
│  - Analytics reads  │    │ - Optimized cache    │
│  - CPU: standard    │    │ - Memory: high       │
│  - Stateless        │    │ - Stateless          │
└──────┬──────────────┘    └───────┬──────────────┘
       │                           │
       └───────────┬───────────────┘
                   ▼
        ┌─────────────────────────┐
        │  Valkey Cluster         │
        │  ├─ L2 Cache            │
        │  ├─ Rate Limit Counter  │
        │  ├─ BullMQ Job Queue    │
        │  └─ Session State       │
        └──┬──────────────────┬───┘
           │                  │
      ┌────▼────┐        ┌────▼─────────┐
      │PostgreSQL
      │ Primary  │        │ Background   │
      │ (Writes) │        │ Workers      │
      │ + 2 Read │        │ (BullMQ)     │
      │ Replicas │        │ - Consume    │
      │ (Reads)  │        │   queue      │
      └──────────┘        │ - Process    │
                          │   analytics  │
                          │ - Write to   │
                          │   click_events
                          └──────────────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │Click Events  │
                          │ DB or        │
                          │ClickHouse    │
                          │(Partitioned) │
                          └──────────────┘
```

---

## **Why Separate API and Redirect Servers?**

### **Read Path (Redirect) Characteristics:**

```
Traffic Pattern: 115,000 requests/second
Cache Hit Rate: 95%+
Processing: Minimal (cache lookup → redirect)
Latency: CRITICAL (< 10ms at p99)
Memory: HIGH (L1 LRU cache)
Auth: NONE (public endpoint)
Error: Rare
```

### **Write Path (API) Characteristics:**

```
Traffic Pattern: 1,160 requests/second
Cache Relevance: Not critical
Processing: Heavy (validation, hashing, DB writes)
Latency: Less critical (user doesn't feel 100ms)
Memory: Standard
Auth: Required (JWT validation)
Error: Common (validation failures)
```

### **Separation Benefits:**

```
1. Independent Scaling:
   - Spike in redirects? Add more redirect servers
   - Spike in creation? Add more API servers

2. Resource Optimization:
   - Redirect: More memory (L1 cache)
   - API: More CPU (validation, hashing)

3. No Contention:
   - Heavy analytics export doesn't slow redirects
   - Rate limiting failures on creation don't affect redirects

4. Deployment:
   - Update API without affecting redirects
   - Rolling deploys per tier
```

---

## **Component Deep Dive**

### **1️⃣ Load Balancer (Nginx/AWS ALB)**

**Responsibilities:**

```
1. TLS Termination
   HTTPS (expensive crypto) happens at Nginx
   HTTP (fast) between Nginx ↔ backends

2. Rate Limiting (Network Layer)
   Reject obvious bots/DDoS before hitting backends
   Token bucket: 10,000 requests/sec per IP

3. Request Routing
   GET /:shortCode  → Redirect Servers (specific pool)
   POST /api/v1/*   → API Servers (specific pool)
   
4. Health Checks
   Periodically: GET /health
   Dead servers auto-removed
```

**Config Example:**

```
upstream redirect_servers {
  server redirect1:3001;
  server redirect2:3001;
  server redirect3:3001;
  keepalive 32;
}

upstream api_servers {
  server api1:3000;
  server api2:3000;
  server api3:3000;
  keepalive 32;
}

server {
  location ~ ^/[a-zA-Z0-9]+$ {
    proxy_pass http://redirect_servers;
    proxy_connect_timeout 1s;  # Tight timeout
    proxy_read_timeout 2s;
  }
  
  location /api/v1/ {
    proxy_pass http://api_servers;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
  }
}
```

---

### **2️⃣ API Servers (3-5 instances)**

**Endpoints Served:**

```
Auth:
  POST /api/v1/auth/register
  POST /api/v1/auth/login
  POST /api/v1/auth/refresh
  POST /api/v1/auth/logout

URL Management:
  POST /api/v1/urls
  GET /api/v1/urls
  GET /api/v1/urls/:shortCode
  PATCH /api/v1/urls/:shortCode
  DELETE /api/v1/urls/:shortCode

Analytics:
  GET /api/v1/urls/:shortCode/analytics/summary
  GET /api/v1/urls/:shortCode/analytics/events

System:
  GET /health
```

**Stack:**

```
Express.js ← HTTP server
  ├─ Middleware (auth, validation, logging)
  ├─ Route handlers
  └─ Database connections (pooled)

PostgreSQL (Primary)
  ← All writes go here
  ← Replicated to 2 read replicas

Valkey
  ← Rate limiting counters
  ← JWT blacklist (optional)
```

---

### **3️⃣ Redirect Servers (5-10 instances)**

**Endpoint Served:**

```
GET /:shortCode → 302 Found
```

**Optimized Stack:**

```
Express.js (minimal middleware)
  ├─ L1 Cache (LRU, 10K entries)
  └─ 3 handlers: cache-hit, cache-miss, error

PostgreSQL (Read Replica Only)
  ← No writes to primary
  ← Less pressure on primary

Valkey
  ← L2 cache lookups
  ← Publish to analytics queue
```

**Code Flow:**

```javascript
app.get('/:shortCode', async (req, res) => {
  // L1 Cache
  let url = l1Cache.get(req.params.shortCode);
  
  if (!url) {
    // L2 Cache
    url = await valkey.get(`url:${req.params.shortCode}`);
    
    if (!url) {
      // L3 Database (Read Replica)
      url = await db.query(
        'SELECT original_url FROM urls WHERE short_code = ?',
        [req.params.shortCode]
      );
      
      if (url) {
        valkey.set(`url:${req.params.shortCode}`, url, 'EX', 86400);
      }
    }
    
    if (url) {
      l1Cache.set(req.params.shortCode, url);
    }
  }
  
  if (!url) {
    return res.status(404).send();
  }
  
  // Return immediately! (< 5ms typical)
  res.redirect(302, url);
  
  // Async: Publish to analytics queue
  analyticsQueue.add({ shortCode, timestamp: Date.now() });
});
```

---

### **4️⃣ Valkey Cache Layer**

**Three Use Cases:**

#### **A. L2 URL Cache**

```
Key: url:abc123
Value: {"originalUrl": "https://amazon.in/...", "expiresAt": "2026-04-20"}
TTL: min(remaining_ttl, 86400 seconds)

At steady state: 95% of reads served here!
```

#### **B. Rate Limit Counters**

```
Key: rl:create:user-uuid:minute
Value: 5  (current count)
TTL: 60 seconds

Key: rl:redirect:ip:minute
Value: 50
TTL: 60 seconds

When counter >= limit → 429 Too Many Requests
```

#### **C. BullMQ Job Queue**

```
Queue: analytics-queue
Messages:
  {
    shortCode: "abc123",
    timestamp: 1713268200000,
    userAgent: "Mozilla/5.0...",
    ipHash: "sha256(...)",
    referrer: "twitter.com"
  }

Processed by background workers:
  - Parse User-Agent
  - Geolocate IP
  - Write to click_events table
```

---

### **5️⃣ PostgreSQL (Primary + Read Replicas)**

**Primary:**

```
Handles all writes:
  INSERT INTO urls (...)
  UPDATE urls SET click_count = ...
  INSERT INTO refresh_tokens (...)
  
Durability: WAL (Write-Ahead Log)
Backup: Continuous replication
```

**Read Replicas (2 instances):**

```
For API servers:
  GET /api/v1/urls (list user's URLs)
  GET /api/v1/urls/:shortCode (analytics)

For Redirect servers:
  SELECT WHERE short_code = ? (cache miss)

Replication Lag: Typically < 1 second
Acceptable? YES! (Cache masks it for redirects)
```

---

### **6️⃣ Background Workers (BullMQ)**

**Purpose:**

```
Process click events asynchronously
Make redirect endpoint fast
Decouple write rate from processing rate
```

**Worker Code:**

```javascript
const queue = new Queue('analytics', connection);

queue.process(async (job) => {
  const { shortCode, userAgent, ipHash, referrer } = job.data;
  
  // Parse User-Agent
  const { device, browser, os } = parseUserAgent(userAgent);
  
  // Write to database
  await db.query(
    `INSERT INTO click_events 
     (url_id, clicked_at, device_type, browser, os, referrer_domain)
     VALUES (?, NOW(), ?, ?, ?, ?)`,
    [urlId, device, browser, os, referrer]
  );
  
  // Update denormalized counter (batch)
  batchUpdateClickCount(urlId, 1);
});

// Batch updates every 100 events or 5 seconds
setInterval(async () => {
  const updates = batchQueue.drain();
  if (updates.size > 0) {
    // Single query handles 100+ URLs
    for (const [urlId, count] of updates) {
      await db.query(
        `UPDATE urls SET click_count = click_count + ? WHERE id = ?`,
        [count, urlId]
      );
    }
  }
}, 5000);
```

**Scalability:**

```
If queue backs up:
  Add more worker instances!
  
Each worker processes ~1000 events/sec
Need to process 115K events/sec?
  115 workers needed

Simple scaling! ✅
```

---

## **URL Generation Strategy**

### **Three Approaches Recap:**

#### **❌ Approach 1: Hash-Based**
```
hash("https://amazon.in/...") = "kd9s2..."
Problem: Same URL = same code (can't have separate analytics)
Problem: Collisions possible
```

#### **❌ Approach 2: Random + DB Check**
```
Generate: random 7-char string
Check: SELECT WHERE short_code = ?
If collision: retry
Problem: At scale, collision probability increases
```

#### **✅ Approach 3: Counter + Base62 (RECOMMENDED)**
```
ID: 1 → "1"
ID: 100 → "1C"
ID: 1,000,000 → "4c92"

Why?
- No collisions (bijective mapping)
- Predictable: 62^7 = 3.5 trillion combinations
- Can shuffle for non-sequential appearance
```

### **Base62 Algorithm:**

```javascript
function base62Encode(num) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  
  while (num > 0) {
    result = alphabet[num % 62] + result;
    num = Math.floor(num / 62);
  }
  
  return result || '0';
}

// Examples
base62Encode(1)        // "1"
base62Encode(100)      // "1C"
base62Encode(1000000)  // "4c92"
```

### **Enumeration Protection (Shuffled Mapping):**

```
Problem: Sequential IDs leak business metrics
  bit.ly/1, bit.ly/2, bit.ly/3...
  → "100,000 URLs created!" (hacker deduced)

Solution: Use shuffled mapping table
  Permutation: [42, 17, 89, 5, ...]
  ID 1 → map[1] = 42 → base62(42) = "g"
  ID 2 → map[2] = 17 → base62(17) = "h"
  
Result: Looks random, actually deterministic!
```

---

## **Caching Strategy Deep Dive**

### **L1 Cache (In-Process LRU)**

```
Data Structure: Least Recently Used (LRU) cache
Capacity: 10,000 entries
Entry Size: ~200 bytes
Total Memory: ~2MB

Example Entry:
  Key: "abc123"
  Value: {
    originalUrl: "https://amazon.in/...",
    expires_at: "2026-04-20T23:59:59Z"
  }

Hit Time: 0.1ms (memory access)
TTL: 60 seconds (short, to avoid sync issues)
```

### **L2 Cache (Valkey Distributed)**

```
Shared across all server instances
TTL: 24 hours (or min(remaining_ttl, 24h))
Hit Time: 1-2ms (network + lookup)
Capacity: Limited by Valkey memory

Invalidation:
  When URL updated:
    DEL url:abc123
  Next access:
    Cache miss → DB fetch → cache repopulate
```

### **Cache Invalidation Rules:**

| Trigger | Action | Why |
|---|---|---|
| URL created | No write (cache-aside) | Only cache if accessed |
| URL accessed (miss) | Write to Valkey | Lazy loading |
| URL updated | DEL from both caches | Serve new value |
| URL deleted | DEL + negative entry | Prevent DB hammering |
| URL expires | TTL auto-evicts | Set correctly on cache |

---

## **Horizontal Scaling**

### **Adding API Servers:**

```
Current: 3 instances
Bottleneck: CPU (validation, hashing, DB writes)

Add instance #4:
  1. Boot new instance
  2. Load balancer starts routing traffic
  3. Connections auto-pooled
  4. No config changes needed!

Stateless = Easy scaling! ✅
```

### **Adding Redirect Servers:**

```
Current: 5 instances
Bottleneck: Traffic spike (viral content)

Add instance #6-10:
  1. Boot with same L1 cache (independent)
  2. All hit same L2 (Valkey)
  3. Load balancer distributes traffic

No state = Easy scaling! ✅
```

### **Adding Valkey Nodes (When Cache Full):**

```
Current: Single Valkey instance
Problem: Too much data for one machine

Solution: Valkey Cluster
  Shard by key hash
  Automatic replication
  No client code changes!
```

---

## **Section 5 Takeaway**

✅ **Architecture Principles:**
- Separate read/write paths
- Stateless servers
- Three-tier caching
- Async analytics pipeline
- Independent scaling tiers

✅ **Components:**
- Load balancer (routing + TLS)
- API servers (write path)
- Redirect servers (read path)
- Valkey (distributed cache + queue)
- PostgreSQL (primary + replicas)
- Workers (analytics processing)

✅ **Scalability:**
- Horizontal: Add servers
- Cache: Add Valkey nodes
- Database: Add replicas

✅ **Performance:**
- p99 redirect < 10ms (cache hit)
- Analytics non-blocking
- Bulk updates efficient

---

**Next:** Section 6 — URL Generation Strategy (Detailed)
