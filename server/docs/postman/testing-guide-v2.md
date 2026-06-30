# Postman Testing Guide v2 — URL Shortener (Days 1–9: Analytics)

> Versioning: `url-shortener-collection.json` is the v1 baseline (Days 1–4).
> `url-shortener-collection-v2.json` (this guide) is cumulative through **Day 9** and
> adds the **Day 7 async analytics pipeline** + **Day 9 analytics read routes**.

## Quick Start

1. **Start all three processes** (no turbo — run each in its own terminal):
   - `npm run dev` in `api`     → API on **:3000**
   - `npm run dev` in `redirect` → redirect server on **:3001**
   - `npm run dev` in `worker`   → BullMQ worker (no port)
   - Infra: `docker compose up postgres valkey -d`
2. **Import collection:** File → Import → `docs/postman/url-shortener-collection-v2.json`
3. **One-time Postman setting:** Settings → General → "Automatically follow redirects: OFF"
   (required to observe the 302s from the redirect server)
4. **Run:** Click "Run collection". Tests execute top-to-bottom and auto-wire variables.

The collection uses **Collection Variables** — no manual copy-pasting.

---

## Variables (auto-managed)

| Variable | Set by | Purpose |
|---|---|---|
| `base_url` | You (default `http://localhost:3000`) | API server |
| `redirect_base_url` | You (default `http://localhost:3001`) | Redirect server (click generation) |
| `access_token` | Register/Login ✅ | Primary user's JWT |
| `second_access_token` | Register (second user) ✅ | Attacker user for the IDOR test |
| `short_code` | Shorten — Basic ✅ | The URL under analytics |
| `test_email` / `second_email` | Pre-request scripts ✅ | Unique emails per run |

---

## Test Map

### 1. Setup (Auth + Create URL)

| Request | Expect |
|---|---|
| ✅ Register (primary user) | 201 + `accessToken` |
| ✅ Register (second user) | 201 + `second_access_token` |
| ✅ Shorten — Basic | 201 + `short_code` stored |

### 2. Generate Clicks (redirect server :3001)

| Request | Notes | Expect |
|---|---|---|
| ✅ Click 1 | `Referer: twitter.com`, mobile UA | 302 + `Location` |
| ✅ Click 2 | `Referer: twitter.com`, desktop UA | 302 |
| ✅ Click 3 | no referer (direct), desktop UA | 302 |

Each redirect enqueues a click event (fire-and-forget). The worker resolves the
short code, geo-enriches the IP, parses the UA, hashes the IP (daily-salted), and
inserts a `click_events` row — then batches the `urls.click_count` increment.

### 3. Analytics (Day 7 + 9)

| Request | Expect |
|---|---|
| ✅ Summary — owner | 200 + locked shape; `totalClicks >= 1`; `dailyBreakdown` non-empty; no `ipHash` leaked |
| ✅ Events — owner, paginated | 200 + `{ events, total, limit, offset }`; rows have `deviceType`, **no** `ipHash`/`ip` |
| ✅ Events — limit=1 | 200 + at most 1 event |
| ❌ Summary — No Auth | 401 |
| ❌ Summary — Unknown Code | 404 |
| ❌ Summary — Other user's URL | **404** (never 403 — IDOR/info-leak prevention) |
| ❌ Events — Other user's URL | **404** |
| ❌ Events — `limit=0` | 400 |

Summary response shape (locked, per `API_CONTRACT.md §Analytics`), wrapped in the
project's `{ success, message, data }` envelope:

```json
{
  "success": true,
  "message": "Analytics retrieved",
  "data": {
    "shortCode": "...", "originalUrl": "...", "createdAt": "...", "expiresAt": null,
    "totalClicks": 3, "last7Days": 3, "last30Days": 3,
    "dailyBreakdown": [{ "date": "2026-06-13", "clicks": 3 }],
    "topReferrers": [{ "referrer": "twitter.com", "clicks": 2 }, { "referrer": "direct", "clicks": 1 }],
    "countries": [{ "countryCode": "US", "countryName": "United States", "clicks": 3 }]
  }
}
```

---

## Async timing — the one thing to know

Click writes are **asynchronous** (BullMQ → worker). The redirect returns 302
*before* the click is persisted. The **Analytics Summary** request therefore waits
~4 s in its pre-request script (`setTimeout`) before asserting `totalClicks >= 1`.

If you see `totalClicks` of 0 under a loaded machine:
- Confirm the **worker process is running** (it logs "Analytics worker started").
- In the collection runner, add a per-request **Delay** of ~3000 ms.
- Re-run just the Analytics folder (the clicks are already enqueued/persisted).

## Error Envelope — Global Check

Every 4xx/5xx is checked at the collection level for `{ "error": string }` with no
`success` key — identical to v1. A leaked stack trace, Prisma message, or
`success: false` fails the collection-level test.

## What "Run Collection" Doesn't Cover

- **Geo enrichment** depends on `ip-api.com` reachability. Against `localhost`/private
  IPs the lookup returns no country, so `countries` may be empty in local runs — this
  is expected (the click is still recorded; `countryCode` falls back to `null`).
- **Daily aggregation** (`daily_analytics_aggregates`) runs nightly at 00:05 UTC in the
  worker and is not exercised by this collection. To verify manually, seed clicks dated
  to "yesterday" and invoke the worker's `runDailyAggregation()`, then inspect the table.
