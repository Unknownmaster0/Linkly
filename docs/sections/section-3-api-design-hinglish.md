# Section 3: API Design — Hinglish Mein

Yeh section mein aapko har endpoint milega jo aapko build karna hai. **API aapka north star hai** — implementation isko follow karega.

---

## **API Versioning Strategy**

**Kya:** Har API route ko `/api/v1/` se start karna

```
Example:
POST /api/v1/auth/register
GET /api/v1/urls
GET /:shortCode  ← ye public hai, version nahi hai
```

**Trade-off:** URL mein version vs Header mein version?

| Approach | Fayda | Nuksan |
|---|---|---|
| **URL mein (`/api/v1/`)** | Clear, easy to test, obvious | Little verbose |
| **Header (`Accept: application/vnd.api+json; version=1`)** | RESTful purist | Complex, debugging hard |

**Answer:** **URL mein version** ✅ (pragmatic choice)

---

## **AUTHENTICATION ROUTES — Login/Register System**

### **1️⃣ Register (Account Banana)**

```
POST /api/v1/auth/register

Request (Kya user send karega):
{
  email: "user@example.com",
  password: "MySecure@Pass123",  // min 8 chars
  name: "Sagar Kumar"
}

Response 201 (Success):
{
  userId: "550e8400-e29b-41d4-a716-446655440000",  // UUID
  email: "user@example.com",
  accessToken: "eyJhbGciOiJIUzI1NiIs...",  // JWT (15 min valid)
  refreshToken: "opaque_token_xyz123..."  // Store in DB (30 days)
}

Response 409 (Email already registered):
{
  error: "Email already in use"
}

Response 422 (Validation failed):
{
  error: "Validation failed",
  details: {
    password: "Must be at least 8 characters"
  }
}
```

**Key Points:**
- Password hashing: **Argon2id** use karo (bcrypt nahi!)
- **Breached password check:** hibp.tech API use karo → user secure password set kar raha hai check karo
- Response 201 → registration successful

---

### **2️⃣ Login (Account Access)**

```
POST /api/v1/auth/login

Request:
{
  email: "user@example.com",
  password: "MySecure@Pass123"
}

Response 200 (Success):
{
  accessToken: "eyJhbGciOiJIUzI1NiIs...",
  refreshToken: "opaque_token_xyz123...",
  expiresIn: 900  // seconds (15 minutes)
}

Response 401 (Bad credentials):
{
  error: "Invalid email or password"
}

Response 429 (Rate limited):
{
  error: "Too many login attempts. Try again in 10 minutes."
}
```

**IMPORTANT Security Rule:**
```
❌ DON'T distinguish:
   "Email not found" vs "Wrong password"
   
❌ DON'T say: "User not registered"
or "Incorrect password"

✅ DO say: "Invalid email or password"
```

**Kyu?** Information leakage! Hacker ko pata chal jayega kaun se emails registered hain.

**Rate Limiting:** Per-IP + Per-account
```
❌ Hacker strategy: Try 1000 passwords fast
✅ Your defense: 5 failed attempts → 10 min block per IP
                 10 failed attempts → account lock
```

---

### **3️⃣ Token Refresh (Access Token Expire)**

```
POST /api/v1/auth/refresh

Request:
{
  refreshToken: "opaque_token_xyz123..."
}

Response 200 (Success):
{
  accessToken: "eyJhbGciOiJIUzI1NiIs...",  // NEW token
  expiresIn: 900  // 15 min valid
}

Response 401 (Token invalid/revoked):
{
  error: "Refresh token expired or revoked"
}
```

**Kya hua:**
```
Timeline:

Start:
- User login → accessToken (15 min) + refreshToken (30 days)
- User ka tab open

10 minutes later:
- User kuch kare → accessToken expired!

User request kare:
- Server: "AccessToken expired"
- Client: POST /refresh with refreshToken
- Server: "OK, new accessToken" ✅
- User: Continue working (seamless)

15 days later:
- RefreshToken expired (30 days ka TTL)
- User: Login again karna padega
```

---

### **4️⃣ Logout (Account Access Revoke)**

```
POST /api/v1/auth/logout

Auth Header required:
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

Request:
{
  refreshToken: "opaque_token_xyz123..."
}

Response 204 (Success - No Content):
{}

Details:
- Database se refresh token entry delete/revoke karo
- User logout → immediately invalid
- Kisi doosre device se ye token use nahi kar payega
```

---

## **URL MANAGEMENT ROUTES — Core Features**

### **1️⃣ Create Short URL (Main Feature)**

```
POST /api/v1/urls

Auth Header required:
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...

Request Body:
{
  originalUrl: "https://www.amazon.in/s?k=laptop&page=2",
  customAlias: "my-awesome-laptop",  // optional
  expiresAt: "2026-04-20T23:59:59Z",  // optional
  tags: ["sale", "electronics"]  // optional
}

Response 201 (Created):
{
  shortCode: "abc123",
  shortUrl: "https://yourdomain.com/abc123",
  originalUrl: "https://www.amazon.in/s?k=laptop&page=2",
  customAlias: "my-awesome-laptop",
  expiresAt: "2026-04-20T23:59:59Z",
  createdAt: "2026-04-16T10:30:00Z"
}

Response 409 (Custom alias already taken):
{
  error: "Alias 'my-awesome-laptop' already in use",
  suggestion: "Try 'my-awesome-laptop-2'"
}

Response 422 (Validation failed):
{
  error: "Validation failed",
  details: {
    originalUrl: "Invalid URL format",
    customAlias: "Must be 3-50 characters"
  }
}

Response 429 (Rate limit):
{
  error: "Rate limit exceeded. Max 10 URLs per minute"
}
```

**Backend Process:**
```
1. Validate originalUrl (format check)
2. Check Safe Browsing API (async — don't block)
3. Check if customAlias available
4. Generate BIGSERIAL ID
5. Encode ID to Base62 → shortCode
6. Insert into database
7. Cache in Valkey (for later redirects)
8. Return shortUrl
```

---

### **2️⃣ Get All URLs for User (Dashboard)**

```
GET /api/v1/urls?page=1&limit=20&sortBy=createdAt&order=desc&tag=sale

Auth Header required

Query Parameters:
{
  page: 1,  // pagination
  limit: 20,  // default 20, max 100
  sortBy: "createdAt" | "clicks" | "expiresAt",
  order: "asc" | "desc",
  tag: "sale",  // optional filter
  search: "laptop"  // search in originalUrl and alias
}

Response 200:
{
  data: [
    {
      shortCode: "abc123",
      shortUrl: "https://yourdomain.com/abc123",
      originalUrl: "https://amazon.in/...",
      clickCount: 1234,
      createdAt: "2026-04-16T10:30:00Z",
      expiresAt: null,
      isActive: true,
      tags: ["sale"]
    },
    { ... more URLs ... }
  ],
  pagination: {
    total: 156,  // total URLs user has
    page: 1,
    limit: 20,
    hasNext: true  // are there more pages?
  }
}
```

**Example Use Cases:**
```
GET /api/v1/urls → All URLs
GET /api/v1/urls?page=2&limit=50 → Different page
GET /api/v1/urls?sortBy=clicks&order=desc → Top URLs by clicks
GET /api/v1/urls?tag=sale → Only 'sale' tagged URLs
GET /api/v1/urls?search=laptop → Search for 'laptop'
```

---

### **3️⃣ Get Single URL (Details)**

```
GET /api/v1/urls/abc123

Auth Header required

Response 200:
{
  shortCode: "abc123",
  shortUrl: "https://yourdomain.com/abc123",
  originalUrl: "https://amazon.in/...",
  clickCount: 1234,
  createdAt: "2026-04-16T10:30:00Z",
  expiresAt: null,
  isActive: true
}

Response 404 (Not found OR user doesn't own):
{
  error: "URL not found"
}
```

**Security Important:**
```
❌ DON'T distinguish:
   "URL not found" vs "You don't own this URL"
   
✅ RETURN 404 for both cases
   (prevents enumeration)
```

---

### **4️⃣ Update URL (Edit)**

```
PATCH /api/v1/urls/abc123

Auth Header required

Request Body (all optional):
{
  originalUrl: "https://new-destination.com",
  customAlias: "new-alias",
  expiresAt: "2026-04-25T23:59:59Z",  // null to remove expiry
  isActive: false  // disable without deleting
}

Response 200 (Updated):
{
  shortCode: "abc123",
  shortUrl: "https://yourdomain.com/abc123",
  originalUrl: "https://new-destination.com",
  ...
}

Response 409 (Alias taken):
{
  error: "Alias already in use"
}

Response 404:
{
  error: "URL not found"
}
```

**Backend Cache Invalidation:**
```
When URL updated:
1. DELETE from Valkey
2. Next redirect = cache miss
3. Database se fetch → cache repopulate
4. User gets updated destination ✅
```

---

### **5️⃣ Delete URL (Remove)**

```
DELETE /api/v1/urls/abc123

Auth Header required

Response 204 (Deleted - No Content):
{}

Response 404:
{
  error: "URL not found"
}
```

**Important Design Decision:**
```
Soft Delete (Recommended):
- Set is_deleted = true
- URL still in database (analytics preserved)
- Redirect returns 410 Gone
- Admin can still view deleted URLs

Hard Delete (NOT recommended):
- DELETE from database
- Analytics LOST forever
- Irreversible
```

---

## **REDIRECT ROUTE — Highest Traffic Endpoint**

```
GET /:shortCode

Auth: None (public, anonymous)

Headers (optional, for analytics):
  User-Agent: "Mozilla/5.0..."
  Referer: "https://twitter.com"
  X-Forwarded-For: "203.0.113.45"

Response 302 (Found - Temporary):
  Location: https://original-long-url.com

Response 404 (Not found):
  {}

Response 410 (Gone - deleted or expired):
  {}

Response 451 (Unavailable - malicious/DMCA):
  {}
```

**Most Important Notes:**
```
⚡ Performance Target: < 10ms at p99
   (p99 = 99th percentile, worst case)

🔄 Process Flow:
   1. Check L1 cache (in-memory) → 0.1ms
   2. Check L2 cache (Valkey) → 1ms
   3. Database miss? Query PostgreSQL → 5ms
   4. Return 302 IMMEDIATELY
   5. Publish click event to queue (non-blocking)
   6. Worker processes event asynchronously

📊 Analytics:
   - Fire-and-forget to queue
   - User never waits for analytics
   - Database write happens in background
   - This is why redirect is FAST
```

**Response Time Breakdown:**
```
Cache Hit (95% of traffic):
Total: 1ms (network + cache lookup)

Cache Miss (5% of traffic):
Total: 6ms (network + DB query)

Goal: p99 < 10ms ✅ (easily achievable)
```

---

## **ANALYTICS ROUTES — Data Insights**

### **1️⃣ Summary Analytics**

```
GET /api/v1/urls/abc123/analytics/summary?from=2026-03-16&to=2026-04-16

Auth Header required (ownership enforced)

Query Parameters:
{
  from: "2026-03-16",  // ISO 8601 date
  to: "2026-04-16"
}

Response 200:
{
  shortCode: "abc123",
  totalClicks: 10234,
  uniqueClicks: 8912,  // distinct users (by IP hash)
  
  clicksByDay: [
    { date: "2026-04-15", clicks: 450 },
    { date: "2026-04-16", clicks: 234 }
  ],
  
  topReferrers: [
    { referrer: "twitter.com", clicks: 5000, percentage: 48.8 },
    { referrer: "linkedin.com", clicks: 3000, percentage: 29.3 },
    { referrer: "direct", clicks: 2234, percentage: 21.8 }
  ],
  
  topCountries: [
    { country: "IN", clicks: 6000, percentage: 58.6 },
    { country: "US", clicks: 2000, percentage: 19.5 },
    { country: "GB", clicks: 1000, percentage: 9.8 }
  ],
  
  deviceBreakdown: {
    mobile: 65.2,
    desktop: 31.4,
    tablet: 3.4
  }
}
```

---

### **2️⃣ Raw Click Events**

```
GET /api/v1/urls/abc123/analytics/events?page=1&limit=50&from=2026-04-16&to=2026-04-16

Auth Header required

Query Parameters:
{
  page: 1,
  limit: 50,  // max 100 per page
  from: "2026-04-16",
  to: "2026-04-16"
}

Response 200:
{
  data: [
    {
      clickedAt: "2026-04-16T10:30:45Z",
      country: "IN",
      city: "Delhi",
      device: "mobile",
      browser: "Chrome",
      referrer: "twitter.com",
      isUnique: true  // first click from this IP today
    },
    { ... more events ... }
  ],
  pagination: {
    page: 1,
    total: 2350,
    hasNext: true
  }
}
```

**Storage Note:**
```
Raw events: Keep 90 days
After 90 days: Aggregate + Delete
(Cost optimization)

Why?
- 10 billion clicks/day × 500 bytes = 5TB/day
- 90 days = 450TB 😱
- Too expensive, aggregate instead
```

---

### **3️⃣ Export Analytics**

```
GET /api/v1/urls/abc123/analytics/export?format=csv&from=2026-01-01&to=2026-04-16

Auth Header required

Query Parameters:
{
  format: "csv" | "json",
  from: "2026-01-01",
  to: "2026-04-16"
}

Response 202 (Accepted - Processing):
{
  jobId: "export-job-12345",
  status: "processing",
  estimatedCompletionTime: "2026-04-16T11:30:00Z"
}

Response 200 (For small datasets < 10K rows):
[File download in CSV/JSON]
```

**Process:**
```
Small dataset (< 10K rows):
Request → Generate CSV immediately → Return

Large dataset (10K+ rows):
Request → Return jobId
Background job → Generate file
Upload to S3 → Send email/webhook with download link
```

---

## **SYSTEM ROUTES — Health Checks**

### **1️⃣ Health Check**

```
GET /health

Auth: None (public)

Response 200:
{
  status: "ok",
  uptime: 3600,  // seconds
  version: "1.0.0",
  timestamp: "2026-04-16T10:30:00Z"
}
```

**Use Case:** Load balancer aur monitoring tools use karte hain
- Server alive hai? → 200
- Server dead? → 503

---

### **2️⃣ Check Alias Availability**

```
GET /api/v1/check/my-awesome-sale

Auth Header required

Response 200 (Available):
{
  available: true,
  suggestion: "my-awesome-sale"
}

Response 200 (Not available):
{
  available: false,
  suggestion: "my-awesome-sale-2"
}
```

**Use Case:** User customAlias type kar raha hai, frontend check kare available hai ya nahi

---

## **Quick Reference — All Endpoints**

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/auth/register` | ❌ | New account create |
| POST | `/api/v1/auth/login` | ❌ | Login |
| POST | `/api/v1/auth/refresh` | ❌ | Token refresh |
| POST | `/api/v1/auth/logout` | ✅ | Logout |
| POST | `/api/v1/urls` | ✅ | Create short URL |
| GET | `/api/v1/urls` | ✅ | List all URLs |
| GET | `/api/v1/urls/:shortCode` | ✅ | Get URL details |
| PATCH | `/api/v1/urls/:shortCode` | ✅ | Update URL |
| DELETE | `/api/v1/urls/:shortCode` | ✅ | Delete URL |
| GET | `/:shortCode` | ❌ | **Redirect** (public) |
| GET | `/api/v1/urls/:shortCode/analytics/summary` | ✅ | Analytics summary |
| GET | `/api/v1/urls/:shortCode/analytics/events` | ✅ | Raw events |
| GET | `/api/v1/urls/:shortCode/analytics/export` | ✅ | Export data |
| GET | `/health` | ❌ | Health check |
| GET | `/api/v1/check/:shortCode` | ✅ | Check availability |

---

## **Key Design Principles (Section 3 ke Core)**

```
1. Versioning in URL (/api/v1/)
   → Clear, easy to debug, pragmatic

2. JWT + Refresh Token (not stateless JWT alone)
   → Revocable, secure, device tracking

3. 302 Redirects (not 301)
   → Every click tracked for analytics

4. Fire-and-forget analytics
   → User experience smooth, processing asynchronous

5. Soft delete only
   → History preserved, compliance friendly

6. Rate limiting on multiple endpoints
   → DDoS protection, abuse prevention

7. Ownership scoping on all queries
   → IDOR prevention, security
```

---

## **Summary — Section 3 Takeaway**

**API Design ka essence:**
- ✅ Clear endpoints jab har operation ke liye
- ✅ Consistent response format
- ✅ Proper HTTP status codes
- ✅ Security built-in (rate limiting, ownership checks)
- ✅ Analytics non-blocking (fire-and-forget)
- ✅ Performance in mind (caching, lazy loading)

**Yeh sab endpoints ko implement karte ho to:**
- Day 2: Auth endpoints
- Day 3: URL creation
- Day 4: Redirect endpoint
- Day 5-7: Caching + Analytics
- Day 9: Analytics routes

**Phir jo build karega, ye API spec follow karega.** ✅

---

**Next:** Section 4 — Database Design (Tables, Indexes, Relationships)
