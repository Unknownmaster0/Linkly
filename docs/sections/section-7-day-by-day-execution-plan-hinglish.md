# Section 7: Day-by-Day Execution Plan — Hinglish Mein

---

> **Philosophy:** Har din ke end mein kuch working hona chahiye. No "just reading" or "just planning" days.

---

## **Week 1 — Foundation & Core**

### **Day 1 — Environment + Database**

**Deliverable:** `docker-compose.yml` mein PostgreSQL + Valkey running. Prisma schema. Tables created.

**Tasks:**

```
1. Create docker-compose.yml
   services:
     postgres:
       image: postgres:16
       env: POSTGRES_PASSWORD=local
       ports: 5432:5432
       volumes: ./data:/var/lib/postgresql/data
     
     valkey:
       image: valkey:8
       ports: 6379:6379

2. npm init -y && npm install express prisma @prisma/client dotenv

3. Create .env.example:
   DATABASE_URL=postgresql://postgres:local@localhost:5432/urlshortener
   VALKEY_URL=redis://localhost:6379

4. Create prisma/schema.prisma:
   - User model
   - URL model
   - RefreshToken model
   
5. prisma migrate dev --name init
   → Creates tables in PostgreSQL

6. Verify in psql:
   \dt  → See tables
   SELECT * FROM users;  → Empty but exists!
```

**Concepts to Understand:**

```
- What is ORM? (Prisma abstracts SQL)
- What is migration? (Schema version control)
- Why PostgreSQL indexes? (B-tree for lookups)
- WAL = Write-Ahead Log (durability guarantee)
```

**Time:** 2-3 hours

**Test:** Run `npm run dev`. No errors. PostgreSQL connections work.

---

### **Day 2 — Auth Foundations**

**Deliverable:** `POST /api/v1/auth/register` + `POST /api/v1/auth/login` working.

**Tasks:**

```
1. Install dependencies:
   npm install argon2 jsonwebtoken uuid

2. Create middleware/auth.ts:
   - hashPassword() using Argon2id
   - generateAccessToken() for 10-min JWT
   - generateRefreshToken() (opaque string)
   - verifyAccessToken()

3. Create routes/auth.ts:
   POST /api/v1/auth/register:
     Input: email, password, name
     Hash password with Argon2id
     Create user in DB
     Generate tokens
     Return: userId, accessToken, refreshToken, expiresIn
   
   POST /api/v1/auth/login:
     Input: email, password
     Find user by email
     Compare password with stored hash
     Generate tokens
     Return: accessToken, refreshToken, expiresIn
     Error handling: 401 if invalid

4. Create error handling middleware:
   - Validation errors: 422
   - Auth errors: 401
   - Server errors: 500

5. Test with curl or Postman:
   POST localhost:3000/api/v1/auth/register
   Body: {"email": "test@example.com", "password": "Test123!"}
   → Should return tokens!
```

**Concepts:**

```
- Argon2id vs bcrypt (memory-hard beats GPU)
- JWT structure: header.payload.signature
- Stateless auth (no session server-side)
- Refresh token in DB (revocable unlike pure JWT)
- Generic error messages: "Invalid email or password"
```

**Time:** 3-4 hours

**Test:** Register user → Get tokens → Can decode JWT. Check DB has user.

---

### **Day 3 — URL Creation**

**Deliverable:** `POST /api/v1/urls` with Base62 encoding working.

**Tasks:**

```
1. Create utils/base62.ts:
   - base62Encode(num: BigInt): string
   - base62Decode(str: string): BigInt
   - Test with examples: 1→"1", 62→"10", 1000000→"4c92"

2. Create routes/urls.ts:
   POST /api/v1/urls:
     Middleware: verify JWT (extract userId)
     Input: originalUrl, customAlias?, expiresAt?, tags?
     
     If customAlias provided:
       Check unique: SELECT WHERE short_code = customAlias
       If taken: return 409 Conflict
       shortCode = customAlias
     Else:
       INSERT into DB (BIGSERIAL auto-increment)
       Get id from insert result
       shortCode = base62Encode(id)
     
     INSERT full record:
       urls(short_code, original_url, user_id, ...)
     
     Return: shortCode, shortUrl, originalUrl, createdAt

3. Create validation schema (Zod):
   - originalUrl must be valid URL format
   - customAlias: alphanumeric + hyphens only
   - expiresAt must be in future if provided

4. Test:
   POST localhost:3000/api/v1/urls
   Header: Authorization: Bearer <token>
   Body: {"originalUrl": "https://amazon.in/..."}
   → Should return {"shortUrl": "http://localhost:3000/abc123"}
```

**Concepts:**

```
- BIGSERIAL auto-increment (0 → max)
- Base62 encoding algorithm (while loop)
- Validation before DB write (reject garbage early)
- Ownership scoping (user owns their URLs)
- Nullable fields (expiresAt, tags optional)
```

**Time:** 2-3 hours

**Test:** Create 5 URLs. Check DB has all. Verify Base62 encoding reversible.

---

### **Day 4 — Redirect Endpoint**

**Deliverable:** `GET /:shortCode` → 302 redirect working. Database lookup only (no cache yet).

**Tasks:**

```
1. Create routes/redirect.ts:
   GET /:shortCode:
     Input: shortCode (from URL parameter)
     
     Query DB:
       SELECT original_url, expires_at, is_active
       FROM urls
       WHERE short_code = ?
     
     If not found:
       return 404
     
     If is_deleted OR is_active = false:
       return 404 (don't expose whether it exists)
     
     If expires_at < NOW():
       return 410 Gone
     
     Async (non-blocking):
       Publish event to analytics queue
     
     Return 302 with Location header

2. HTTP Status Codes:
   - 302 Found: Temporary redirect (analytics-enabled)
   - 404 Not Found: URL doesn't exist OR no permission
   - 410 Gone: URL expired or deleted
   - 451 Unavailable For Legal Reasons: Flagged as malicious

3. Middleware for this endpoint:
   - No auth needed (public)
   - Minimal logging (high traffic!)
   - Response time tracking

4. Test with browser:
   Visit http://localhost:3000/shortCode
   → Should redirect to original URL
   Check response headers:
     HTTP/1.1 302 Found
     Location: https://amazon.in/...
```

**Concepts:**

```
- 302 vs 301: Temporary vs Permanent
  301 = browser caches, never hits server again
  302 = every click hits server (better for analytics)
  
- 404 vs 410:
  404 = temporarily unavailable (might come back)
  410 = gone for good (don't ask again)
  
- IDOR prevention: Return 404 whether URL doesn't exist or no permission
  Never expose: "URL exists but you don't own it" (403)
```

**Time:** 2 hours

**Test:** Create URL → Get shortCode → Visit in browser → Redirects to original URL.

---

### **Day 5 — Valkey Caching Layer**

**Deliverable:** Cache-aside pattern implemented. Redirect latency measured (< 5ms cache hit).

**Tasks:**

```
1. Install redis client:
   npm install ioredis

2. Create utils/cache.ts:
   - Connect to Valkey: new Redis(process.env.VALKEY_URL)
   - Async get(key): value
   - Async set(key, value, ttl): void
   - Async del(key): void

3. Update redirect handler:
   GET /:shortCode:
     1. Check Valkey: val = await valkey.get(`url:${shortCode}`)
     2. If found: return 302 (FAST! < 2ms)
     3. If miss:
        - Query DB
        - valkey.set(`url:${shortCode}`, JSON.stringify(data), 'EX', 86400)
        - return 302
     
4. Update URL mutation handlers:
   On PATCH /api/v1/urls/:shortCode:
     - Update DB
     - await valkey.del(`url:${shortCode}`)  ← Invalidate!
   
   On DELETE /api/v1/urls/:shortCode:
     - Mark deleted in DB
     - await valkey.del(`url:${shortCode}`)
     - Set negative entry (optional): 
       valkey.set(`url:${shortCode}:deleted`, true, 'EX', 30)

5. Measure latency:
   Create load: curl in loop 100 times
   First call: ~7ms (DB hit)
   Second call: ~2ms (cache hit)
   
6. Monitor in Valkey:
   redis-cli
   > KEYS url:*
   > TTL url:shortCode
```

**Concepts:**

```
- Cache-aside: Application checks cache, populates on miss
- TTL: Data expires automatically (86400 = 24 hours)
- Invalidation: Synchronous (delete immediately)
- Negative caching: Remember deleted items briefly (prevent thundering herd)
```

**Time:** 2-3 hours

**Test:** Measure response time. First redirect ~7ms, second ~2ms. Verify TTL with redis-cli.

---

### **Day 6 — Rate Limiting**

**Deliverable:** Token bucket rate limiting on create + redirect endpoints.

**Tasks:**

```
1. Create middleware/rateLimit.ts:
   Token Bucket Algorithm:
     Per-IP limit on GET /:shortCode (anti-bot)
     Per-user limit on POST /api/v1/urls (anti-abuse)
   
   In Valkey:
     Key: rl:create:user-id
     Value: current_count
     TTL: 60 seconds (rolling window)
   
   Implementation:
     async function checkRateLimit(key, limit, window) {
       const count = await valkey.incr(key);
       if (count === 1) {
         await valkey.expire(key, window);
       }
       if (count > limit) {
         return false;  // Rate limited!
       }
       return true;
     }

2. Apply middleware:
   GET /:shortCode:
     rateLimit('redirect:ip:' + req.ip, 100, 60)  ← 100/min per IP
   
   POST /api/v1/urls:
     rateLimit('create:user:' + userId, 10, 60)  ← 10/min per user

3. Test:
   Bash loop to hammer endpoint:
     for i in {1..15}; do
       curl http://localhost:3000/test
     done
   
   Expected:
     First 10: 200 or 302
     11-15: 429 Too Many Requests

4. Error handling:
   If Valkey down:
     Fail open (allow request)
     Log warning
     Circuit breaker pattern (if frequent)
```

**Concepts:**

```
- Token Bucket: Fixed capacity, refills over time
- Per-IP vs Per-user: Different rate limits
- Centralized in Valkey: Works across multiple servers
- Fail open: Better to allow abuse than block everyone
- 429 status code: "Too Many Requests"
```

**Time:** 2 hours

**Test:** Hit endpoint >10 times in 60 seconds → 429 response. Verify counter in redis-cli.

---

### **Day 7 — Async Analytics Pipeline**

**Deliverable:** BullMQ queue + worker processing click events asynchronously.

**Tasks:**

```
1. Install:
   npm install bullmq

2. Create workers/analytics.ts:
   Queue: "analytics"
   
   Job payload:
     {
       shortCode: "abc123",
       timestamp: Date.now(),
       userAgent: "Mozilla/5.0...",
       ipHash: "sha256(...)",
       referrer: "twitter.com"
     }

3. Worker logic:
   For each job:
     - Parse User-Agent: device, browser, OS
     - Call free IP geolocation API (maxmind GeoLite2)
     - Insert into click_events table
     - Update urls.click_count (batch updates)

4. Update redirect handler:
   GET /:shortCode:
     ... (302 redirect logic)
     
     // Non-blocking!
     queue.add('analytics', {
       shortCode,
       timestamp: Date.now(),
       userAgent: req.headers['user-agent'],
       ipHash: sha256(req.ip),
       referrer: req.headers.referer
     });

5. Measure impact:
   Time redirect before analytics:
     Typical: 5-7ms
   
   Time redirect after analytics (with queue):
     Typical: 5-7ms (same!)
   
   Analytics latency is not on critical path! ✅

6. Monitor queue:
   bullmq UI: npm install @bull-board/express
   Visit: http://localhost:3000/admin/queues
   See: Jobs processed, stuck jobs, etc.
```

**Concepts:**

```
- Message queue: Buffer between producer (requests) and consumer (worker)
- Non-blocking: Return immediately, process in background
- Eventual consistency: Analytics slightly delayed
- Worker scalability: Slow database? Add workers!
- Job persistence: Redis-backed, survives restarts
```

**Time:** 3-4 hours

**Test:** Create many URLs, generate traffic. Verify click_events table populated after ~5 second delay.

---

## **Week 2 — Production Hardening**

### **Day 8 — Input Validation + Security**

**Deliverable:** Zod schemas on all inputs. Security headers. IDOR prevention.

**Tasks:**

```
1. Install: npm install zod @hapi/boom

2. Create validation schemas:
   
   RegisterSchema:
     email: string().email().max(255)
     password: string()
       .min(8)
       .regex(/[A-Z]/, "Uppercase required")
       .regex(/[0-9]/, "Number required")
     name: string().min(2).max(100)
   
   CreateUrlSchema:
     originalUrl: string().url().max(2048)
     customAlias: string().regex(/^[a-zA-Z0-9-]{3,50}$/).optional()
     expiresAt: string().datetime().optional()
   
   3. Apply middleware (helmet):
     npm install helmet
     app.use(helmet())  ← Adds security headers
       - Content-Security-Policy
       - X-Frame-Options: DENY
       - X-Content-Type-Options: nosniff
       - Strict-Transport-Security: max-age=31536000

4. IDOR Prevention:
   Every query scoped to user:
   
   GET /api/v1/urls/:shortCode (must be owner):
     const url = await db.url.findUnique({
       where: { shortCode },
       include: { user: true }
     });
     
     if (url.userId !== requestingUserId) {
       return 404;  // Never expose "403 Forbidden"!
     }

5. URL validation edge cases:
   ❌ Reject: "javascript:alert(1)"
   ❌ Reject: "data:text/html,<script>..."
   ❌ Reject: "http://localhost:8080"  (internal)
   ✅ Allow: "https://example.com"
   ✅ Allow: "https://192.168.1.1"  (external)

6. Test security:
   curl -X POST http://localhost:3000/api/v1/urls \
     -H "Content-Type: application/json" \
     -d '{"originalUrl": "javascript:alert(1)"}'
   
   Expected: 422 Unprocessable Entity

7. Check headers:
   curl -I http://localhost:3000/health
   Look for: X-Frame-Options, Content-Security-Policy, etc.
```

**Concepts:**

```
- Zod: Schema validation + parsing
- Helmet: Security headers (CSP, HSTS, etc.)
- IDOR: Return 404 whether not found or no permission
- URL validation: Whitelist allowed schemes (http, https)
- Generic errors: Never expose which field/user exists
```

**Time:** 3 hours

**Test:** Submit invalid data → 422. Submit unauthorized request → 404. Check security headers.

---

### **Day 9 — Analytics Routes + Aggregation**

**Deliverable:** `GET /api/v1/urls/:shortCode/analytics/summary` working. Daily aggregation job running.

**Tasks:**

```
1. Create analytics aggregation job:
   Runs at: 00:05 UTC daily
   
   Logic:
     FOR EACH url_id:
       SELECT country_code, COUNT(*) as count
       FROM click_events
       WHERE url_id = ? AND DATE(clicked_at) = YESTERDAY
       GROUP BY country_code
       
       INSERT INTO daily_analytics_aggregates
         (url_id, date, total_clicks, top_countries, ...)
       VALUES (...)
   
   Speed: ~1 minute for 1B click events (partitioning helps!)

2. Create GET /api/v1/urls/:shortCode/analytics/summary:
   Query parameters:
     from: date (default: 30 days ago)
     to: date (default: today)
   
   Logic:
     SELECT SUM(total_clicks), top_countries, device_breakdown
     FROM daily_analytics_aggregates
     WHERE url_id = ? AND date BETWEEN from AND to
   
   Return:
     {
       shortCode: "abc123",
       totalClicks: 10234,
       uniqueClicks: 8932,
       topCountries: [
         {country: "IN", clicks: 5000, percentage: 48.8},
         {country: "US", clicks: 3000, percentage: 29.3}
       ],
       deviceBreakdown: {
         mobile: 70.5,
         desktop: 28.2,
         tablet: 1.3
       }
     }

3. Create GET /api/v1/urls/:shortCode/analytics/events:
   Paginated raw click events (90-day retention)
   
   Query:
     SELECT * FROM click_events
     WHERE url_id = ?
       AND clicked_at > NOW() - INTERVAL '90 days'
     ORDER BY clicked_at DESC
     LIMIT 20 OFFSET 0

4. Install cron job:
   npm install node-cron
   
   schedule.scheduleJob('0 5 * * *', async () => {
     await runAnalyticsAggregation();
   });

5. Test:
   - Insert mock click events manually
   - Run aggregation job
   - Query analytics endpoints
   - Verify numbers add up!
```

**Concepts:**

```
- Denormalized counters: click_count updated async
- Daily aggregates: Pre-computed for fast queries
- CQRS pattern: Write raw, read aggregated
- Retention policy: Keep raw events 90 days
- Cron jobs: Scheduled tasks
```

**Time:** 3 hours

**Test:** Insert click events. Run aggregation. Query summary → should match raw events.

---

### **Day 10 — Graceful Shutdown + Error Handling**

**Deliverable:** Server responds to SIGTERM by draining connections and shutting down cleanly.

**Tasks:**

```
1. Implement graceful shutdown:
   
   const server = app.listen(PORT);
   
   process.on('SIGTERM', async () => {
     console.log('SIGTERM received, starting graceful shutdown...');
     
     // Stop accepting new connections
     server.close(async () => {
       console.log('HTTP server closed');
       
       // Close DB pool
       await db.$disconnect();
       console.log('Database pool closed');
       
       // Stop queue consumers
       await queue.close();
       console.log('Job queue closed');
       
       // Close Valkey
       await valkey.quit();
       console.log('Valkey closed');
       
       // Exit process
       process.exit(0);
     });
     
     // Force exit after 30 seconds (timeout safety)
     setTimeout(() => {
       console.error('Graceful shutdown timeout, forcing exit!');
       process.exit(1);
     }, 30000);
   });

2. Centralized error handler:
   
   app.use((err, req, res, next) => {
     if (err instanceof ValidationError) {
       return res.status(422).json({
         code: 'VALIDATION_ERROR',
         message: err.message,
         fields: err.fieldErrors
       });
     }
     
     if (err instanceof NotFoundError) {
       return res.status(404).json({
         code: 'NOT_FOUND',
         message: 'Resource not found'
       });
     }
     
     // Unexpected error
     logger.error('Unhandled error', { err, req: req.url });
     
     return res.status(500).json({
       code: 'INTERNAL_ERROR',
       message: 'Something went wrong'
     });
   });

3. Handle unhandled rejections:
   
   process.on('unhandledRejection', (reason, promise) => {
     logger.error('Unhandled Promise Rejection', { reason, promise });
     process.exit(1);
   });

4. Test:
   - Run server
   - Send SIGTERM: kill -TERM <pid>
   - Observe: "Draining connections..." messages
   - Check: No hanging connections
```

**Concepts:**

```
- SIGTERM: Kubernetes termination signal (30 sec window)
- SIGKILL: Cannot be caught (always kills)
- Graceful shutdown: Finish in-flight work before exit
- Connection draining: No new requests, finish existing ones
- Timeout safety: Force exit after 30s anyway
```

**Time:** 2 hours

**Test:** Send SIGTERM → observe clean shutdown → no hanging connections.

---

### **Day 11 — Link Expiry + Background Jobs**

**Deliverable:** Expired URLs return 410. Nightly cleanup job deletes old links.

**Tasks:**

```
1. Lazy expiry check (at redirect):
   GET /:shortCode:
     const url = await db.url.findUnique({
       where: { shortCode },
       select: { originalUrl, expiresAt }
     });
     
     if (!url) return 404;
     
     if (url.expiresAt && url.expiresAt < new Date()) {
       return 410;  // Gone
     }
     
     return 302 redirect;

2. Eager cleanup job (nightly):
   Runs at: 01:00 UTC
   
   UPDATE urls
   SET is_deleted = true
   WHERE expires_at < NOW() AND is_deleted = false;
   
   Impact: Keeps table clean, removes from indexes

3. Negative Valkey entry:
   When URL expires:
     valkey.set(`url:${shortCode}:expired`, true, 'EX', 30)
   
   On redirect attempt:
     if (await valkey.exists(`url:${shortCode}:expired`)) {
       return 410;
     }

4. Test expiry:
   - Create URL with expiresAt = 2 minutes from now
   - Immediate redirect: works (200)
   - After 2 minutes: returns 410
   - Next day: is_deleted = true in DB

5. Monitor job execution:
   Log each run:
     "Cleanup job: deleted 1234 expired URLs"
```

**Concepts:**

```
- Lazy expiry: Check at read time (correct)
- Eager expiry: Cleanup job (efficient)
- Both needed: Correctness + storage management
- Soft delete: is_deleted flag (preserves analytics)
- TTL indexing: Partial index WHERE expires_at IS NOT NULL
```

**Time:** 2 hours

**Test:** Create expiring URL. Verify 410 after expiry. Check is_deleted in DB next day.

---

### **Day 12 — Structured Logging**

**Deliverable:** All logs in JSON format. Request IDs propagated. Pino configured.

**Tasks:**

```
1. Install: npm install pino pino-pretty

2. Create logger instance:
   import pino from 'pino';
   
   const logger = pino({
     transport: process.env.NODE_ENV === 'production'
       ? undefined  // JSON to stdout
       : {
           target: 'pino-pretty',
           options: { colorize: true }
         }
   });
   
   export { logger };

3. Request ID middleware:
   import { v4 as uuid } from 'uuid';
   
   app.use((req, res, next) => {
     req.id = uuid();
     res.setHeader('X-Request-ID', req.id);
     next();
   });

4. Log every request:
   app.use((req, res, next) => {
     const start = Date.now();
     
     res.on('finish', () => {
       const duration = Date.now() - start;
       logger.info({
         requestId: req.id,
         method: req.method,
         path: req.path,
         statusCode: res.statusCode,
         duration,
         userId: req.userId  // If authenticated
       });
     });
     
     next();
   });

5. Example log output:
   Development (pretty):
     [INFO] GET /api/v1/urls 200 in 45ms
   
   Production (JSON):
     {"level":30,"time":"2026-04-16T10:23:14.234Z","requestId":"abc123","method":"GET","path":"/api/v1/urls","statusCode":200,"duration":45}

6. Never log:
   ❌ Passwords, API keys
   ❌ Raw IPs (use hashed IP)
   ❌ Email addresses in JSON (PII)
   ✅ Request ID (tracing)
   ✅ Status codes (debugging)
   ✅ Duration (performance)
```

**Concepts:**

```
- Structured logging: Machine-parseable (not strings)
- Request ID: Trace single request through logs
- Log levels: debug < info < warn < error < fatal
- Correlation ID: Match logs across services
- Log aggregation: Send to ELK/Datadog in production
```

**Time:** 2 hours

**Test:** Make requests. Check stdout for JSON logs. Grep by request ID.

---

### **Day 13 — AWS EC2 Deployment**

**Deliverable:** Application running on EC2. PM2 managing process. Nginx reverse proxy.

**Tasks:**

```
1. Create EC2 instance:
   - t3.micro (free tier)
   - Ubuntu 22.04 LTS
   - Security group: allow 80, 443, 22
   - Create keypair, download .pem

2. SSH into instance:
   ssh -i key.pem ubuntu@<ec2-ip>

3. Install dependencies:
   sudo apt update
   sudo apt install -y nodejs npm nginx git

4. Install PM2:
   sudo npm install -g pm2

5. Clone repository:
   git clone <repo-url>
   cd url-shortener
   npm install

6. Configure Nginx:
   sudo nano /etc/nginx/sites-available/default
   
   upstream app {
     server 127.0.0.1:3000;
   }
   
   server {
     listen 80 default_server;
     server_name _;
     
     location / {
       proxy_pass http://app;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   
   sudo systemctl restart nginx

7. Start with PM2:
   pm2 start npm --name url-shortener -- start
   pm2 save  ← Saves auto-restart on reboot
   pm2 startup  ← Enables on system startup

8. Check status:
   pm2 status
   curl http://localhost/health

9. Set up environment:
   Create .env file with secrets (not in git!)
   DATABASE_URL=...
   VALKEY_URL=...

10. Verify:
    Access http://<ec2-ip>
    Should see application running!

11. Optional: HTTPS with Let's Encrypt:
    sudo apt install certbot python3-certbot-nginx
    sudo certbot --nginx
```

**Concepts:**

```
- PM2: Process manager (auto-restart, clustering)
- Nginx: Reverse proxy (TLS, compression, routing)
- Security groups: Firewall rules
- Elastic IP: Static public IP
- DNS: Point domain.com to EC2 IP
```

**Time:** 2-3 hours

**Test:** Access EC2 IP in browser. See application. Check PM2 status.

---

### **Day 14 — Polish + Documentation**

**Deliverable:** README with architecture diagram. Postman collection. Proper .env.example. Deployment guide.

**Tasks:**

```
1. Update README.md:
   - What is this?
   - Architecture diagram (Excalidraw export)
   - Quick start: docker-compose + npm install
   - Project structure
   - API endpoints
   - Configuration

2. Create postman collection:
   - Export all endpoints
   - Example requests
   - Import into Postman to test

3. Create .env.example:
   DATABASE_URL=postgresql://...
   VALKEY_URL=redis://localhost:6379
   PORT=3000
   LOG_LEVEL=debug
   JWT_SECRET=<256-bit random hex>
   JWT_REFRESH_SECRET=<different 256-bit hex>

4. Create DEPLOYMENT.md:
   - AWS setup steps
   - Environment variables
   - TLS setup
   - Monitoring

5. Create ARCHITECTURE.md:
   - Component diagram
   - Data flow
   - Caching strategy
   - Scaling guide

6. Verifiable deliverables:
   - Run npm run dev → app starts
   - Create URL via API → works
   - Visit short URL in browser → redirects
   - Generate traffic → logs appear
   - PM2 restart → auto-restart works

7. Code quality:
   npm run lint  → No errors
   npm run test  → All pass
   npm run build → No errors

8. Final checklist:
   ✅ No hardcoded secrets in code
   ✅ Error messages don't leak info
   ✅ Security headers present
   ✅ Database indexes present
   ✅ Logging structured (JSON)
   ✅ Graceful shutdown works
   ✅ Rate limiting active
   ✅ Analytics queue processing
   ✅ Deployment documented
```

**Concepts:**

```
- Documentation: Code is read more than written
- Examples: Show API usage
- Architecture diagrams: Visual clarity
- Deployment guides: Reproducible setup
- Checklists: Ensure nothing forgotten
```

**Time:** 2-3 hours

**Test:** Clone repo fresh. Follow README. Get working in <5 minutes.

---

## **Summary — 14 Days**

| Day | Focus | Complexity | Dependencies |
|---|---|---|---|
| 1 | Database + Docker | Low | None |
| 2 | Authentication | Medium | Day 1 |
| 3 | URL Creation | Medium | Days 1-2 |
| 4 | Redirect Handler | Low | Days 1, 3 |
| 5 | Caching | Medium | Days 1, 4 |
| 6 | Rate Limiting | Medium | Days 1, 5 |
| 7 | Analytics Queue | High | Days 1-4 |
| 8 | Validation + Security | Medium | Days 2-3 |
| 9 | Analytics Routes | Medium | Days 1, 7 |
| 10 | Graceful Shutdown | Low | Day 1 |
| 11 | Expiry + Cleanup | Medium | Days 1, 3 |
| 12 | Logging | Low | All |
| 13 | EC2 Deployment | Medium | Days 1-12 |
| 14 | Documentation | Low | Days 1-13 |

---

**Section 7 Takeaway**

✅ **Phased delivery:** Something working every day

✅ **Build foundation first:** DB → Auth → Create → Redirect

✅ **Add scale handling:** Caching → Rate limiting → Analytics

✅ **Harden for production:** Validation → Security → Logging

✅ **Ship to production:** Deployment → Documentation → Polish

---

**Next:** Section 8 — Edge Cases & Failure Handling
