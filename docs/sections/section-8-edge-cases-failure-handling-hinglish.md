# Section 8: Edge Cases & Failure Handling — Hinglish Mein

---

## **Edge Case 1: Duplicate URL Creations**

### **Scenario:**

```
User creates same URL twice:
  1st time: POST /api/v1/urls
            Body: {"originalUrl": "https://amazon.in/"}
            Returns: "bit.ly/abc123"
  
  2nd time: POST /api/v1/urls
            Body: {"originalUrl": "https://amazon.in/"}
            Returns: ??? 
```

### **Decision: Allow It (Multiple Short Codes for Same URL)**

```
Return: "bit.ly/xyz789" (different code)

Why?
- Same URL might be shared in different contexts
  - Campaign 1: amazon.in → abc123
  - Campaign 2: amazon.in → xyz789
  
- Separate analytics per code
  abc123 clicks = 1000
  xyz789 clicks = 500
  → Understand which campaign is more effective!

- If rejected: User doesn't know "already shortened"
  Better UX: Return existing code with message:
    {
      shortCode: "abc123",
      message: "Already shortened! This code existed.",
      createdAt: "2026-04-10T..."
    }
```

### **Optional Optimization:**

```javascript
// Check if user already shortened this URL
const existing = await db.url.findFirst({
  where: {
    original_url: originalUrl,
    user_id: userId
  }
});

if (existing) {
  return 409 Conflict:
    {
      shortCode: existing.shortCode,
      message: "URL already shortened",
      isNew: false
    }
}

// Otherwise, proceed with new creation
```

---

## **Edge Case 2: URL Expiration Race Condition**

### **Scenario:**

```
URL expires at: 2026-04-20 12:00:00

Two simultaneous requests:
  Request A: arrives at 11:59:59.999
  Request B: arrives at 12:00:00.001
```

### **Timeline:**

```
Request A:
  1. Check expires_at < NOW()
     → false (expires_at is in 1ms!)
  2. Return 302 ✓

Request B:
  1. Check expires_at < NOW()
     → true (expired!)
  2. Return 410 ✓

Result: NO race condition!
Why? Comparison is atomic in DB
```

### **Cache Edge Case:**

```
What if URL is cached in Valkey?

URL created: 2026-04-10
Valkey TTL: 86400 seconds (24 hours)
URL expires: 2026-04-15 (5 days away)

Problem: Cached for 24 hours but expires in 5 days
→ Cache entry dies before URL expires ✓

But what if?
Valkey TTL: 86400 seconds
URL expires: 2026-04-11 (in 2 hours)

Problem: Cache lives 24 hours, URL expires in 2 hours!
→ Stale cache serving after expiry!

Solution: When caching, set TTL = min(remaining_ttl, 86400)
```

**Correct Code:**

```javascript
async function getUrl(shortCode) {
  // L2 Cache lookup
  const cached = await valkey.get(`url:${shortCode}`);
  if (cached) return JSON.parse(cached);
  
  // DB lookup
  const url = await db.url.findUnique({ where: { shortCode } });
  
  if (!url) return null;
  
  // Cache with smart TTL!
  if (url.expires_at) {
    const remainingMs = url.expires_at - Date.now();
    const ttlSeconds = Math.min(remainingMs / 1000, 86400);
    if (ttlSeconds > 0) {
      await valkey.set(`url:${shortCode}`, JSON.stringify(url), 'EX', ttlSeconds);
    }
  } else {
    // Never expires
    await valkey.set(`url:${shortCode}`, JSON.stringify(url), 'EX', 86400);
  }
  
  return url;
}
```

---

## **Edge Case 3: Enumeration Attacks**

### **Scenario:**

```
Attacker writes:
  for i in range(0, 100000):
    curl http://bit.ly/i
    → Discovers all short URLs
```

### **Defenses:**

#### **Defense 1: Use Shuffled Base62**

```
Normal: "1", "2", "3", "4", ...
Shuffled: "8", "x", "K", "5", ...
→ Looks random, actually bijective
→ Attacker can't guess pattern
```

#### **Defense 2: Rate Limiting**

```
Per-IP limit: 100 requests/minute to /:shortCode
Attacker discovers: 100 codes/minute maximum
→ Slows enumeration significantly
```

#### **Defense 3: Negative Cache Entry**

```
When 404 for non-existent code:
  SET valkey /:shortCode:404 "not_found" EX 30
  
Next request for same code:
  → Cached 404 (no DB query)
  
Attacker needs different codes to bypass cache
→ Even slower!
```

#### **Defense 4: CAPTCHAs + Account Verification**

```
Suspicious access pattern detected:
  - 1000 404s in 10 minutes?
  - Same IP, different codes?
  → Trigger CAPTCHA or block
```

### **Verdict:**

```
Complete enumeration protection: Difficult
Practical enumeration mitigation: Easy
→ Shuffled Base62 + rate limiting sufficient
```

---

## **Edge Case 4: Link Enumeration (User's URLs)**

### **Scenario:**

```
Attacker knows user UUID: abc-123-def-456
Tries: GET /api/v1/users/abc-123-def-456/urls
→ Should NOT work!
```

### **Defense: Authentication + Scoping**

```
GET /api/v1/urls (no user ID in path!)
  Auth: Bearer token required
  Server extracts userId from token
  
Query:
  SELECT * FROM urls WHERE user_id = ?

User can only see their own URLs
Can't enumerate other users' URLs!
```

---

## **Edge Case 5: XSS in Original URL**

### **Scenario:**

```
User inputs: originalUrl = "javascript:alert(1)"
System creates: shortCode = "abc123"
Attacker shares: bit.ly/abc123
Victim clicks → JavaScript executes!
```

### **Defense:**

```javascript
// Input validation
const schema = z.object({
  originalUrl: z.string().url()
});

// URL parsing
try {
  const url = new URL(originalUrl);
  // url.protocol must be http or https
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Invalid protocol');
  }
} catch {
  throw new ValidationError('Invalid URL');
}

// Stored value is safe (URL string, not executed)
// When redirecting: res.redirect(url)
// Browser follows Location header (safe)
```

**Result:** `javascript:` URLs rejected at validation time.

---

## **Edge Case 6: LDAP/SQL Injection via URL**

### **Scenario:**

```
Attacker inputs:
  originalUrl = "https://example.com'; DROP TABLE users;--"
```

### **Defense: Parameterized Queries**

```javascript
// Wrong (SQL injection vulnerable):
db.query(`INSERT INTO urls (original_url) VALUES ('${originalUrl}')`);

// Correct (parameterized):
db.query('INSERT INTO urls (original_url) VALUES (?)', [originalUrl]);

// Prisma (ORM, auto-parameterized):
await db.url.create({
  data: { originalUrl }  // Automatically escaped!
});
```

**Result:** Original URL treated as data, not code. No injection.

---

## **Edge Case 7: Database Connection Pool Exhaustion**

### **Scenario:**

```
App has: DB_POOL_SIZE = 10 connections
Traffic surge: 100 concurrent requests
Requests 11-100: Wait for connection from pool
After 30s timeout: 502 Bad Gateway
```

### **Monitoring:**

```javascript
// Monitor pool utilization
setInterval(() => {
  const poolStatus = db.$metrics.pool;
  if (poolStatus.available < 2) {
    logger.warn('Low connection pool!', { poolStatus });
  }
}, 5000);
```

### **Scaling:**

```
Option 1: Increase pool size
  DB_POOL_SIZE = 20 (but each connection uses memory)

Option 2: Add read replicas (for read queries)
  URLs/redirects use replica
  → Less pressure on primary

Option 3: Connection pooling middleware
  PgBouncer between app and PostgreSQL
  → Reuses connections more efficiently
  
Recommended: Option 2 (read replicas)
```

---

## **Edge Case 8: Rate Limiter Failure (Valkey Down)**

### **Scenario:**

```
Valkey is down!
App tries to check rate limit:
  await valkey.incr('rl:user:123')
  → Connection timeout!
```

### **Decision: Fail Open**

```javascript
async function checkRateLimit(key, limit, window) {
  try {
    const count = await valkey.incr(key);
    if (count === 1) {
      await valkey.expire(key, window);
    }
    return count <= limit;
  } catch (error) {
    logger.warn('Rate limiter failed, allowing request', { error });
    return true;  // Fail open!
  }
}
```

**Why fail open?**

```
Fail open (allow):
  Brief bypass of rate limiting
  Acceptable: attacker gets 1% extra requests
  
Fail closed (deny):
  All requests blocked!
  Result: Complete service outage
  
Outcome: Fail open is better!
```

### **Alternative: Circuit Breaker**

```javascript
const circuitBreaker = {
  failureCount: 0,
  state: 'CLOSED',  // normal
  
  async check() {
    try {
      await valkey.ping();
      this.failureCount = 0;
      this.state = 'CLOSED';
      return true;
    } catch {
      this.failureCount++;
      if (this.failureCount > 5) {
        this.state = 'OPEN';  // Stop trying!
      }
      return false;
    }
  }
};

// In rate limiter:
if (circuitBreaker.state === 'CLOSED') {
  return await checkRateLimit(...);
} else {
  return true;  // Valkey is dead, allow everything
}
```

---

## **Edge Case 9: Cache Stampede (Thundering Herd)**

### **Scenario:**

```
Viral URL: 1B clicks/day
Cached in Valkey with TTL = 86400

At 86400 seconds:
  Cache entry expires!
  50,000 simultaneous requests for same code
  All cache miss simultaneously
  → 50,000 DB queries at once!
  → DB CPU spikes
  → Queries slow down
  → More requests queue
  → Cascading failure!
```

### **Solution 1: Probabilistic Early Expiry (PER)**

```javascript
const REFRESH_PROBABILITY = 0.05;  // 5%

async function getUrl(shortCode) {
  const cached = await valkey.get(`url:${shortCode}`);
  
  if (cached) {
    // Before returning cached value, maybe refresh it
    if (Math.random() < REFRESH_PROBABILITY) {
      // Async refresh (non-blocking)
      refreshCache(shortCode).catch(console.error);
    }
    return JSON.parse(cached);
  }
  
  // Cache miss
  const url = await db.url.findUnique({ where: { shortCode } });
  if (url) {
    await valkey.set(`url:${shortCode}`, JSON.stringify(url), 'EX', 86400);
  }
  return url;
}

// Eventually, popular items get refreshed before expiry!
```

### **Solution 2: Stale-While-Revalidate**

```
Approach: Serve stale + revalidate in background

Valkey TTL: 86400
Revalidation trigger: After 80000 seconds (93% of TTL)

When accessed after 80k seconds:
  1. Serve stale cached value immediately (user happy!)
  2. Async refresh cache in background
  
Result: User never waits, cache refreshed continuously
```

### **Solution 3: Mutex Lock**

```javascript
async function getUrl(shortCode) {
  const cacheKey = `url:${shortCode}`;
  const lockKey = `url:${shortCode}:lock`;
  
  const cached = await valkey.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  // Try acquire lock
  const locked = await valkey.set(lockKey, '1', 'NX', 'EX', 5);
  
  if (!locked) {
    // Another request is fetching from DB
    // Wait for their result
    await new Promise(r => setTimeout(r, 100));
    const cached = await valkey.get(cacheKey);
    if (cached) return JSON.parse(cached);
  }
  
  // I have the lock, fetch from DB
  const url = await db.url.findUnique({ where: { shortCode } });
  await valkey.set(cacheKey, JSON.stringify(url), 'EX', 86400);
  await valkey.del(lockKey);
  
  return url;
}
```

**Verdict:** PER + Stale-While-Revalidate is best for read-heavy.

---

## **Edge Case 10: Duplicate Click Events**

### **Scenario:**

```
User clicks, network hiccup, client retries
Same IP, same URL, 1 second apart

Result: Same click recorded twice?
```

### **Prevention: Idempotency**

```
Each click event has unique ID:
  {
    clickId: uuid(),  ← Unique per click attempt
    shortCode,
    timestamp,
    ip,
    ...
  }

Worker logic:
  INSERT INTO click_events (...) VALUES (...)
  ON CONFLICT (click_id) DO NOTHING;  ← Ignore duplicates!
```

**Result:** Retries don't create duplicate analytics.

---

## **Edge Case 11: Malicious URL Detection**

### **Scenario:**

```
User shortens: "https://evil-malware-distribution.com/trojan.exe"
System doesn't detect
Thousands of people click
→ Malware spread!
```

### **Solution: Safe Browsing API**

```javascript
async function checkUrlSafety(url) {
  try {
    // Google Safe Browsing API (free tier)
    const isMalicious = await googleSafeBrowsing.check(url);
    
    if (isMalicious) {
      // Don't block creation (UX friction)
      // Just flag it
      await db.url.update({
        where: { shortCode },
        data: { is_flagged: true }
      });
      
      // Return 451 on redirect
    }
  } catch (error) {
    // API down: allow anyway (fail open)
    logger.warn('Safety check failed', { error });
  }
}

// Async processing (don't block creation):
queue.add('safety-check', { urlId, url });

// Handle flagged URL at redirect:
if (url.is_flagged) {
  return res.status(451).json({
    error: 'This URL has been flagged as potentially harmful'
  });
}
```

---

## **Edge Case 12: Database Primary Failure**

### **Scenario:**

```
PostgreSQL primary goes down!
Redirects still work (read replicas + cache)
But URL creation fails (needs primary)
```

### **Detection:**

```javascript
async function ensureWriteConnection() {
  try {
    await db.$executeRaw`SELECT 1`;
  } catch {
    logger.error('Primary database unavailable!');
    res.status(503).json({
      error: 'Service temporarily unavailable'
    });
    return false;
  }
  return true;
}
```

### **Recovery:**

```
Option 1: RDS Multi-AZ (AWS)
  Automatic failover to replica
  RPO: ~1 second
  RTO: ~1 minute

Option 2: Manual failover
  Promote replica to primary manually
  RPO: ~5 seconds
  RTO: ~5 minutes
```

**Result:** Redirects continue working. Creation temporarily fails (acceptable).

---

## **Section 8 Takeaway**

| Edge Case | Impact | Mitigation |
|---|---|---|
| Duplicate URLs | Analytics split | Allow multiple codes |
| Expiry race | Cache staleness | Smart cache TTL |
| Enumeration | Security | Shuffle Base62 + rate limit |
| XSS in URL | Security | Input validation + HTML escaping |
| SQL injection | Security | Parameterized queries |
| Pool exhaustion | Availability | Connection pooling + replicas |
| Rate limiter down | Availability | Fail open + circuit breaker |
| Cache stampede | Performance | PER + stale-while-revalidate |
| Duplicate events | Analytics | Idempotent event processing |
| Malicious URLs | Safety | Safe Browsing API + flagging |
| DB primary failure | Availability | Multi-AZ + replicas |

---

**Next:** Section 9 — Performance & Optimization
