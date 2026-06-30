# Section 9: Performance & Optimization — Hinglish Mein

---

## **Target Metrics**

```
Redirect latency (p99): < 10ms
Create latency (p95): < 200ms
Analytics query: < 500ms

Redirect availability: 99.99%
System reliability: 99.9% (3 nines)
```

---

## **Redirect Path Optimization (Most Critical)**

### **Current Stack:**

```
User Request
  ↓ (network)
Nginx Reverse Proxy (~1ms)
  ↓
Node.js App
  ├─ L1 Cache (LRU) → hit: 0.1ms
  ├─ L2 Cache (Valkey) → hit: 1-2ms
  └─ L3 DB (Replica) → hit: 5-7ms
  ↓
Redirect Response
  ↓ (network)
Browser
```

### **Latency Breakdown (Typical):**

| Component | Latency | % of Total |
|---|---|---|
| Network (client→server) | 2ms | 20% |
| Nginx | 1ms | 10% |
| L2 Cache hit | 1ms | 10% |
| JSON parse + return | 1ms | 10% |
| Network (server→client) | 5ms | 50% |
| **Total** | **~10ms** | |

### **How to Reduce Each:**

#### **1. Network Latency (2ms)**

**Current:** User → Data center (50-100ms away geographically)

**Optimization: CDN**

```
Deploy to multiple regions:
  US: bit.ly hosted in us-east-1
  EU: bit.ly hosted in eu-west-1
  IN: bit.ly hosted in ap-south-1
  
User in India:
  bit.ly = ap-south-1 server (5-10ms)
  Before: 50-100ms!
  
Savings: 40-90ms per request!
```

**How:**
- Use AWS CloudFront (CDN)
- Cache redirect responses for 1 hour
- Browser requests → CDN edge → hits redirect
- CDN misses → queries origin

#### **2. Nginx Reverse Proxy (1ms)**

**Current:** Nginx → node process

**Optimization: Minimize Nginx processing**

```
server {
  location ~ ^/[a-zA-Z0-9]+$ {
    # Minimal processing
    proxy_pass http://app:3000;
    
    # Keep-Alive (reuse connections)
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    
    # TLS session reuse
    ssl_session_cache shared:SSL:1m;
    ssl_session_timeout 5m;
  }
}
```

**Savings:** 0.5-1ms if optimized

#### **3. L1 Cache Optimization (0.1ms)**

**Current:** In-process LRU cache (10K entries)

**Increase capacity:**
```javascript
const cache = new LRU({
  max: 100000,  // Increased from 10K
  maxSize: 100 * 1024 * 1024,  // 100MB instead of 2MB
  ttl: 1000 * 60 * 5  // 5 minutes
});

// More hot URLs cached
// Higher hit rate (99%+ of traffic)
```

**Trade-off:**
```
More memory: 100MB instead of 2MB
Benefit: 99% cache hit vs 95%
→ 5% of traffic avoids L2 lookup (1ms savings)

Worth it!
```

#### **4. L2 Cache Optimization (1-2ms)**

**Current:** Valkey single-threaded

**Optimizations:**

```javascript
// A. Connection pooling
const pool = new redis.Cluster(nodes, {
  maxRedirections: 3,
  retryDelayOnFailover: 10,
  retryDelayOnClusterDown: 300,
});

// B. Pipelining (batch multiple commands)
const pipe = valkey.pipeline();
pipe.get(`url:${code1}`);
pipe.get(`url:${code2}`);
pipe.get(`url:${code3}`);
const results = await pipe.exec();
// 3 commands in 1 round-trip!

// C. Cluster for throughput
Valkey Cluster = multiple nodes
Each node handles subset of keys
Throughput: N × single-node-throughput
```

**Savings:** 0.5-1ms with clustering

#### **5. Database Query Optimization (5-7ms)**

**Current:** SELECT WHERE short_code = ?

**Optimizations:**

```sql
-- Index existing?
EXPLAIN ANALYZE
SELECT * FROM urls WHERE short_code = 'abc123';

-- Should show: Index Scan using idx_urls_short_code
-- If missing: CREATE UNIQUE INDEX...

-- Selectivity:
SELECT * FROM urls WHERE short_code = 'abc123'
-- Returns 1 row (short_code is unique)
-- Index scan is optimal!

-- What if queries get slower?
-- Check index bloat: SELECT * FROM pg_stat_user_indexes;
-- Rebuild if needed: REINDEX INDEX idx_urls_short_code;
```

**Replica routing:**

```javascript
// Write primary
db.write.query('INSERT ...');

// Read replicas
db.read.query('SELECT ...');  ← Distributes across replicas
```

**Savings:** Query consistently 5-7ms (replicas distribute load)

---

## **Write Path Optimization (URL Creation)**

### **Current Flow:**

```
Request: POST /api/v1/urls
  1. Validate URL (1ms)
  2. Hash password? No, already done
  3. Check custom alias uniqueness (2-5ms if collision check)
  4. INSERT into DB (5-10ms)
  5. Return response
  
Total: 10-20ms
```

### **Optimizations:**

#### **1. Custom Alias Collision Check**

**Current:**
```sql
SELECT COUNT(*) FROM urls WHERE short_code = ?
```

**Problem:** Every creation checks collision even if no custom alias!

**Optimized:**
```javascript
if (customAlias) {
  // Check cache first (faster!)
  const cached = await l1Cache.get(`alias:${customAlias}`);
  if (cached) {
    throw new Error('Already taken');
  }
  
  // Only if not in cache
  const exists = await db.query(
    'SELECT id FROM urls WHERE short_code = ?',
    [customAlias]
  );
  
  if (exists) {
    l1Cache.set(`alias:${customAlias}`, true, ttl);  // Cache misses too!
    throw new Error('Already taken');
  }
}
```

**Savings:** 3-5ms if not colliding (cache hit)

#### **2. Batch Inserts**

**Current (Bulk Create):**
```javascript
// Loop over 10,000 URLs
for (const url of urls) {
  await db.url.create({ data: url });  // 10,000 queries!
}
// Total: 10,000 × 10ms = 100 seconds!
```

**Optimized:**
```javascript
// Batch all at once
await db.url.createMany({
  data: urls  // All 10,000 in 1 query!
});
// Total: 100-200ms!
// 500x faster!
```

#### **3. Deferred Validation**

**Current:**
```javascript
// Validate before each insert (slow)
for (const url of urls) {
  validateUrl(url);  // Calls external API, 5ms each!
  const exists = await checkIfShortened(url);  // DB query
}
```

**Optimized:**
```javascript
// Quick validation first
for (const url of urls) {
  if (!isValidUrlFormat(url)) {
    throw new Error();
  }
}

// Then batch insert
await db.url.createMany({ data: urls });

// Async validation after (doesn't block)
queue.add('validate-urls', { urls });
```

**Savings:** 100ms per bulk request

---

## **Analytics Query Optimization**

### **Problem Query:**

```sql
SELECT country_code, COUNT(*) as count
FROM click_events
WHERE url_id = 123 AND clicked_at > NOW() - INTERVAL '30 days'
GROUP BY country_code
ORDER BY count DESC;
```

**At Bitly scale:** 10B clicks/day → 300B clicks/month!

**Without aggregates:** Scans 300B rows! 💀 (30 seconds+)

**With aggregates:** Scans 30 rows! 🚀 (1ms)

### **Pre-aggregation Strategy:**

#### **Granularity Levels:**

```
Level 1: RAW_CLICK_EVENTS (90 days)
  Every click recorded
  Use for: Recent analytics, detailed drill-down
  Query latency: Slow (full scan)

Level 2: HOURLY_AGGREGATES (1 year)
  Aggregated hourly (country, device, referrer)
  Use for: Last 1 month, reasonable detail
  Query latency: Fast (365 * 24 = 8,760 rows)

Level 3: DAILY_AGGREGATES (5 years)
  Aggregated daily (country, device)
  Use for: Historical trends, annual reports
  Query latency: Very fast (1,825 rows)
```

#### **Aggregation Job:**

```javascript
async function aggregateAnalytics() {
  // Run at 00:05 UTC daily
  
  // Hourly aggregation (previous hour)
  for (let hour = -24; hour <= 0; hour++) {
    const startTime = addHours(now(), hour);
    const endTime = addHours(startTime, 1);
    
    const aggregated = await db.query(`
      SELECT url_id, country_code, device_type,
             COUNT(*) as clicks,
             COUNT(DISTINCT ip_hash) as unique_clicks
      FROM click_events
      WHERE clicked_at >= ? AND clicked_at < ?
      GROUP BY url_id, country_code, device_type
    `, [startTime, endTime]);
    
    await db.hourly_analytics.insertMany(aggregated);
  }
  
  // Daily aggregation (yesterday)
  const yesterday = subDays(now(), 1);
  const dailyAgg = await db.query(`
    SELECT url_id, country_code, device_type,
           SUM(clicks) as total_clicks,
           SUM(unique_clicks) as unique_clicks
    FROM hourly_analytics
    WHERE DATE(datetime) = ?
    GROUP BY url_id, country_code, device_type
  `, [yesterday]);
  
  await db.daily_analytics.insertMany(dailyAgg);
  
  // Purge raw events older than 90 days
  await db.click_events.deleteMany({
    where: { clicked_at: { lt: subDays(now(), 90) } }
  });
}
```

---

## **Database Query Performance Audit**

### **Find Slow Queries:**

```sql
-- PostgreSQL slow query log
ALTER SYSTEM SET log_min_duration_statement = 100;  -- 100ms threshold
SELECT pg_reload_conf();

-- Check slow queries
SELECT query, calls, mean_time, max_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;
```

### **Index Analysis:**

```sql
-- Unused indexes (candidates for removal)
SELECT schemaname, tablename, indexname
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY idx_blks_read DESC;

-- Index bloat (rebuild if >30%)
SELECT relname, 100 - round(avg_leaf_density, 2)::numeric as bloat
FROM pgstattuple_approx(indexrelname)
WHERE 100 - round(avg_leaf_density, 2)::numeric > 30;
```

---

## **Memory Optimization**

### **L1 Cache Memory Usage:**

```
Current: LRU with 10K entries
Memory: ~2MB

Optimized: LRU with 100K entries
Memory: ~100MB

Per-server memory: 500MB total
  L1 cache: 100MB (20%)
  Node.js heap: 300MB (60%)
  Buffers: 100MB (20%)
```

### **Valkey Memory Usage:**

```
Current: All URLs forever
Memory: Unbounded!

Optimized: TTL-based eviction
  Hot URLs: 24 hours (auto-expire)
  Memory: Bounded to X GB
  
Config:
  maxmemory: 10G
  maxmemory-policy: allkeys-lru  ← Evict LRU when full
```

---

## **CPU Optimization**

### **Node.js CPU Profiling:**

```bash
# Start with profiling flag
node --prof app.js

# Generate readable output
node --prof-process isolate-*.log > profile.txt

# Check what's expensive
head -50 profile.txt
```

### **Common Bottlenecks:**

```
1. JSON parsing (large request bodies)
   Optimize: Stream parsing
   
2. Password hashing (Argon2)
   Optimize: Rate-limit registration endpoint
   
3. Base62 encoding/decoding
   Optimize: Pre-compute for hot codes (rare)
   
4. User-Agent parsing
   Optimize: Move to background worker
```

---

## **Monitoring & Alerting**

### **Key Metrics:**

```
Application:
  - Request latency (p50, p95, p99)
  - Error rate (4xx, 5xx)
  - Throughput (requests/second)

Cache:
  - L1 hit rate
  - L2 hit rate
  - Valkey memory usage

Database:
  - Query latency (p99)
  - Connection pool utilization
  - Slow queries count

Business:
  - URLs created/day
  - Clicks/day
  - Active users
```

### **Alerts:**

```
Trigger: Redirect p99 latency > 20ms
  → Check cache hit rates, DB query time

Trigger: Error rate > 0.1%
  → Check error logs, connection pools

Trigger: Database connections > 80% pool
  → Add more replicas or scale vertically
```

---

## **Benchmarking Tools**

### **Load Testing:**

```bash
# Apache Bench
ab -n 10000 -c 100 http://localhost:3000/abc123

# Wrk (more accurate)
wrk -t4 -c100 -d30s http://localhost:3000/abc123

# Results:
# 10000 requests completed in 5 seconds
# 2000 requests/sec
# Latency avg: 50ms, max: 200ms
```

### **Database Benchmark:**

```bash
# pgbench
pgbench -c 10 -j 2 -T 60 -U postgres urlshortener

# Measures transactions/second
```

---

## **Section 9 Takeaway**

✅ **Redirect Optimization:**
- L1 + L2 + L3 caching
- CDN for network latency
- Optimized Nginx config
- Connection pooling

✅ **Write Optimization:**
- Batch inserts (500x faster)
- Cache collision checks
- Deferred validation

✅ **Analytics Optimization:**
- Pre-aggregation (hourly + daily)
- Partitioned tables
- Raw event retention (90 days)

✅ **Monitoring:**
- Slow query logging
- Cache hit rate tracking
- Latency percentiles

✅ **Benchmarking:**
- Load testing tools
- Database profiling
- CPU flamegraphs

---

**Next:** Section 10 — Interview Perspective
