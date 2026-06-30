# Section 2: Features Breakdown — Hinglish Mein

---

## **Core Features — MVP ke liye Zaroori Cheezein**

### **1️⃣ URL Shortening**

**Kya hai:** User ek long URL deta hai → aapko short code dena hai

**Example:**
- **Input:** `https://www.amazon.in/s?k=laptop&i=electronics&ref=nb_sb_noss_2&page=142`
- **Output:** `bit.ly/abc123`

**Trade-off Question:**
> **Random code use karu ya Sequential ID?**

| Approach | Fayda | Nuksan |
|---|---|---|
| **Random (Base62)** | Unpredictable, hacker ko guess nahi kar sakta | Collision ka risk (dono code same bane?) |
| **Sequential ID** | Simple, collision nahi | Hacker enumerate kar sakta: try 1,2,3,4... sab URLs dekh le |

**Real Example:** 
- Agar sequential use karo: `bit.ly/1`, `bit.ly/2`, `bit.ly/3`... 
- Hacker: "Oye 100,000 URLs hain company ke!" (leak of business metrics) ❌
- Aur sab URLs bhi try kar sakta hai

**Answer:** **Random shuffled Base62 use karo** ✅

---

**Another Trade-off:** Custom Alias

**Kya:** User apna custom short URL bana sakta hai?

```
POST /api/v1/urls
{
  originalUrl: "https://amazon.in/...",
  customAlias: "my-awesome-sale"  ← User wants this
}

Response: bit.ly/my-awesome-sale
```

**Problem:** Agar koi pehle se `my-awesome-sale` use kar chuka to? 
- Collision detection karna padega
- Database mein check karna padega: "Ye alias available hai?"

---

### **2️⃣ Redirection**

**Kya hai:** User `bit.ly/abc123` visit kare → original URL par redirect

**Trade-off Question:**
> **301 Redirect use karu ya 302?**

| Code | Matlab | Analytics | Cache? |
|---|---|---|---|
| **301 Permanent** | "Hamesha yehi URL hai" | ❌ **Miss karo** (browser cache karta hai) | Browser cache karta hai |
| **302 Temporary** | "Abhi ke liye yehi URL hai" | ✅ **Sab record hota hai** | Browser har baar server se poochta hai |

**Real Scenario:**

```
Ek user 10 baar same short URL click kare:

301 Redirect use karo:
- Click 1: Server hit → redirect
- Click 2-10: Browser ke cache se (server ko nahi pata!) ❌
- Analytics: 1 click record (actually 10 the!)

302 Redirect use karo:
- Click 1-10: Har baar server hit → redirect ✅
- Analytics: 10 clicks record (sahi!)
```

**Answer:** **302 use karo analytics-enabled links ke liye** ✅

---

### **3️⃣ Analytics Tracking**

**Kya hai:** Count karo ki kitne clicks hua? Kaun se countries se? Device kya?

```
Dashboard example:
- Total Clicks: 10,234
- Unique Clicks: 8,912
- Top Countries: India (5,000), USA (2,000), UK (1,000)
- Device Breakdown: Mobile (70%), Desktop (28%), Tablet (2%)
```

**Trade-off Question:**
> **Analytics synchronously likhu ya asynchronously?**

**❌ Synchronous (Bad):**
```
User click kare
→ Redirect response ready
→ Database mein analytics likho (5-10ms wait) ← USER FEELS THIS!
→ Redirect response send
```
**Problem:** Har redirect 10ms slow! 115K/second = Disaster! 💀

**✅ Asynchronous (Good):**
```
User click kare
→ Click event ko queue mein dal do (instantly)
→ Redirect response send (fast!) ✅
→ Background worker queue se pick kare
→ Worker database mein likhe (database ka pressure)
→ User ko nahi pata
```

**Answer:** **Async + Queue pattern use karo** ✅

---

**Another Trade-off:** Granularity vs Storage

```
❌ Store EVERY click:
  {
    clickedAt: "2026-04-16 10:30:45",
    ip: "192.168.1.1",
    referrer: "twitter.com",
    userAgent: "Mozilla/5.0...",
    country: "India",
    device: "mobile"
  }
  
  Problem: 10 billion clicks per day = MASSIVE storage
  
✅ Aggregate daily:
  {
    date: "2026-04-16",
    totalClicks: 10000,
    topCountries: {"India": 5000, "USA": 3000},
    deviceBreakdown: {mobile: 70%, desktop: 30%}
  }
  
  Fayda: Chhota storage
  Nuksan: Fine-grain details lost (kyunki aggregate kar diya)
```

**Answer:** **Hybrid approach:** Raw events 90 days rakh, fir aggregate karke delete karo ✅

---

### **4️⃣ User Authentication**

**Kya hai:** Har user ko login system de

**Trade-off Question:**
> **JWT stateless use karu ya Session-based?**

| Approach | Fayda | Nuksan |
|---|---|---|
| **JWT (Stateless)** | Server ko state nahi maintain karna, mobile-friendly | Revoke nahi kar sakte (token expire hone tak valid) |
| **Session (Stateful)** | Logout → immediately invalid | Server ko sessions store karne hain, scale nahi hota |

**Answer:** **JWT + Refresh Token (Hybrid)** ✅

```
JWT Architecture:
┌─────────────────────────────────────────┐
│ Access Token (15 min expiry)            │ ← User har request mein ye bhejta hai
│ Stateless, signed JWT                   │
└─────────────────────────────────────────┘
                    ↓ (expires)
┌─────────────────────────────────────────┐
│ Refresh Token (30 days expiry)          │ ← Database mein store hai
│ Opaque, can be revoked                  │ ← Logout karo = revoke karo
└─────────────────────────────────────────┘
```

---

## **Advanced Features — Zyada Zaroori Nahi, Lekin Nice to Have**

### **1️⃣ Link Expiration (TTL)**

**Kya hai:** URL ko expiry date de do

```
Example:
POST /api/v1/urls
{
  originalUrl: "https://sale.com",
  expiresAt: "2026-04-20 23:59:59"  ← 4 din baad expire
}

Aaj: URL works ✅
4 din baad: Returns 410 Gone ❌
```

**Use Cases:**
- Temporary campaign links (sale sirf 7 din)
- One-time access links
- Privacy (link automatically delete)

**Trade-off:** Kaise enforce karu?

```
❌ Eager Deletion:
   Background job every hour:
   DELETE WHERE expires_at < NOW()
   Problem: Job fail ho sakta hai, or scheduling issues

✅ Lazy Check:
   Har redirect time par check karo:
   IF expires_at < NOW() → return 410
   Problem: Dead records database mein pad rahe hain

✅✅ Both (Best):
   - Lazy check: Quick response
   - Eager cleanup: Nightly job (storage clean)
```

---

### **2️⃣ Custom Domains**

**Kya hai:** User apna domain use kar sake

```
Default: bit.ly/abc123
Custom: go.mycompany.com/abc123  ← User ka brand
```

**Complexity:** HIGH 📈
- DNS verification
- TLS certificate (Let's Encrypt)
- Per-tenant routing at load balancer

**Answer:** **Phase 2 mein build karo** (MVP mein nahi)

---

### **3️⃣ Bulk URL Creation**

**Kya hai:** Ek baar mein 10,000 URLs create karo

```
❌ Bad:
for (let i = 0; i < 10000; i++) {
  await db.createUrl(urls[i])  ← 10,000 database calls! 💀
}

✅ Good:
await db.createUrlsBatch(urls)  ← 1 database call
```

**Answer:** **Batch insertion use karo** ✅

---

### **4️⃣ QR Code Generation**

**Kya hai:** Short URL ka QR code bana do

```
bit.ly/abc123 → [QR CODE IMAGE]
                (physical posters par lagta hai)
```

**Trade-off:** Generate on-demand ya pre-generate?

```
❌ Pre-generate on creation:
   Sab URLs ka QR banao
   Problem: 90% URLs ka QR kabhi scan nahi hoga (waste!)

✅ On-demand + Cache:
   User request kare → generate → cache in CDN
   Problem: First time slow, but mostly cached
```

**Answer:** **On-demand + CDN caching** ✅

---

## **Production Features — Real-World Survival**

### **1️⃣ Rate Limiting**

**Kya hai:** Same user/IP ko bahut zyada requests send karne se rok do

**Why?**
```
❌ Without rate limiting:
   - Hacker 10,000 URLs create kare 1 second mein
   - Bot 1M redirects kare genuine traffic ko slow kare
   - Analytics inflate kare
```

**Trade-off:** In-process vs Centralized?

```
❌ In-Process (Each server apna counter):
   Server 1: 5 requests
   Server 2: 5 requests
   Server 3: 5 requests
   Total: 15 (limit of 10 hai!) ❌ Bypass!

✅ Centralized (Redis mein counter):
   Redis: 15 requests (shared)
   Total: 15 (exceed! reject!) ✅
```

**Answer:** **Valkey/Redis mein centralized counter** ✅

**Fail scenario:** Agar Valkey down ho?

```
❌ Fail Closed: Reject all requests → Full outage
✅ Fail Open: Allow requests → Brief bypass but service works
```

**Answer:** **Fail open** ✅ (Brief bypass better than full outage)

---

### **2️⃣ Link Preview / Safety Scanning**

**Kya hai:** Malicious links ko catch karo

**Example:**
```
Phishing link: bit.ly/fake-amazon
↓ (Check against Google Safe Browsing API)
Malicious! Flag set. 
↓ (Redirect time)
Return 451 Unavailable For Legal Reasons
```

**Trade-off:** Sync ya Async?

```
❌ Sync:
   User create URL
   → Check Google API (500ms wait) ← SLOW!
   → Respond

✅ Async:
   User create URL
   → URL created immediately
   → Background job checks
   → If malicious, flag set
   → (Brief window of exposure, but creation fast!)
```

**Answer:** **Async scanning** ✅

---

### **3️⃣ Webhook Notifications**

**Kya hai:** Every click pe user ka system ko notify karo

**Example:**
```
User's CRM system:
"Ye link click hua 100 times yesterday!"
(Without polling our API)
```

**Problem:** Reliability
- Webhook delivery fail ho sakta hai
- Network issue
- User's server down

**Solution:** Outbox Pattern
```
Click event → Database + Webhook payload (atomic)
→ Background job attempts webhook delivery
→ Retry with backoff
→ Dead-letter queue if all retries fail
```

---

## **Quick Summary — Section 2**

**Core Features (MVP):**
- ✅ URL Shortening (random, shuffled Base62)
- ✅ Redirection (302, analytics-enabled)
- ✅ Analytics (async queue + aggregation)
- ✅ Auth (JWT + Refresh token)

**Advanced Features (Phase 2):**
- 🔄 Expiry (lazy check + eager cleanup)
- 🔄 Custom domains (complex, defer)
- 🔄 Bulk creation (batch insertion)
- 🔄 QR codes (on-demand + cache)

**Production Features (MVP + hardening):**
- ✅ Rate limiting (centralized, fail open)
- ✅ Safety scanning (async)
- 🔄 Webhooks (outbox pattern)

---

## **Key Insight — Section 2**

> **Har feature ke saath trade-off decision hota hai. Aapko samajhna hai:**
> - **Why** ye feature?
> - **Which approach** pick karu?
> - **What's the cost?**

---

## **Trade-offs Summary Table**

| Feature | Decision | Why |
|---|---|---|
| Short Code | Random Base62 | Unguessable, secure |
| Redirect | 302 | Full analytics tracking |
| Analytics | Async | Redirect speed critical |
| Auth | JWT+Refresh | Revocable, stateless |
| Expiry | Lazy+Eager | Fast check + clean storage |
| Bulk | Batch insert | 100x faster |
| QR | On-demand | No waste, CDN cached |
| Rate Limit | Centralized | Cross-server enforcement |
| Safety | Async scan | Non-blocking creation |

---

## **Real-World Scenario — Campaign Marketing**

```
Company: "Diwali sale, 50,000 products, 50,000 short URLs"

MVP approach (Section 2 decisions):
1. Random Base62 URLs → unpredictable ✅
2. 302 redirects → track every click ✅
3. Async analytics → fast redirects ✅
4. Rate limiting → prevent abuse ✅
5. Safety scanning → no malicious links ✅

Result:
- Users click smoothly
- Analytics accurate
- No fraud/spam
- Scalable solution ✅
```

---

## **Section 2 Takeaway**

**MVP ke liye:**
- ✅ Core 4 features (shortening, redirect, analytics, auth)
- ✅ Production features (rate limiting, safety)
- ✅ Smart trade-offs (async, soft-delete, etc.)

**Phase 2 mein:**
- 🔄 Advanced features (expiry, custom domains, webhooks)

**Concept kar lo: Kya build karna hai, kaun se trade-offs, kaun se approaches**

---

**Next:** Section 3 — API Design (Har endpoint ka structure)
