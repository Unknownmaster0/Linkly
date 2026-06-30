# Postman Testing Guide — URL Shortener Days 1–4

## Quick Start

1. **Start the server:** `npm run dev` in `api/`
2. **Import collection:** File → Import → `docs/postman/url-shortener-collection.json`
3. **One-time Postman setting:** Settings → General → "Automatically follow redirects: OFF"  
   (Required to see the 302 on redirect tests — otherwise Postman follows it silently)
4. **Run:** Click "Run collection" — tests execute in order, variables auto-wire

The collection uses **Collection Variables** (not an Environment). All tokens and generated data are stored there automatically — no manual copy-pasting.

---

## Variables (auto-managed)

| Variable | Set by | Purpose |
|---|---|---|
| `base_url` | You (default: `http://localhost:3000`) | Server root |
| `test_email` | Pre-request on Register ✅ | Unique email per run |
| `test_password` | Collection default (`Password123`) | Valid password |
| `access_token` | Post-response on Register ✅ / Login ✅ / Refresh ✅ | JWT for Bearer auth |
| `short_code` | Post-response on Shorten basic ✅ | Used in redirect tests |

---

## Test Map

### 1. Health

| # | Request | Expect |
|---|---|---|
| 1 | GET /health | 200 — `{status:"ok", db:"ok"}` |

### 2. Auth — Register

| # | Request | Body highlight | Expect |
|---|---|---|---|
| 2 | ✅ Register — Happy Path | valid email + password | 201 + `accessToken` + cookie |
| 3 | ❌ Register — Missing Email | `{}` | 400 |
| 4 | ❌ Register — Invalid Email | `email:"not-email"` | 400 |
| 5 | ❌ Register — Password Too Short | `password:"abc1"` | 400 |
| 6 | ❌ Register — No Number in Password | `password:"PasswordOnly"` | 400 |
| 7 | ❌ Register — Passwords Don't Match | `confirmPassword:"Different999"` | 400 |
| 8 | ❌ Register — Duplicate Email | same email as #2 | 409 |

### 3. Auth — Login

| # | Request | Body highlight | Expect |
|---|---|---|---|
| 9 | ✅ Login — Valid Credentials | correct email + password | 200 + `accessToken` + cookie |
| 10 | ❌ Login — Wrong Password | `password:"WrongPass999"` | 401 (same message as #11) |
| 11 | ❌ Login — Unknown Email | `email:"nobody@example.com"` | 401 (same message as #10) |

> Tests #10 and #11 both assert the error message is identical — this verifies no user enumeration.

### 4. Auth — Refresh

| # | Request | Notes | Expect |
|---|---|---|---|
| 12 | ✅ Refresh — Valid Cookie | browser/Postman sends cookie automatically | 200 + new `accessToken` |
| 13 | ❌ Refresh — No Cookie | manually clear `refreshToken` cookie in Postman cookie jar first | 401 |

> For #13: Postman → Cookies (top-right) → find `localhost` → delete `refreshToken` → send.

### 5. Auth — Logout

| # | Request | Notes | Expect |
|---|---|---|---|
| 14 | ✅ Logout — Authenticated | uses `Authorization: Bearer {{access_token}}` | 204 + `Set-Cookie: Max-Age=0` |
| 15 | ❌ Logout — No Bearer Token | Authorization header disabled | 401 |

### 6. Shorten URL

All requests in this folder send `Authorization: Bearer {{access_token}}`.

| # | Request | Body highlight | Expect |
|---|---|---|---|
| 16 | ✅ Shorten — Basic | `url:"https://google.com/..."` | 201 + `shortCode` + rate limit headers |
| 17 | ✅ Shorten — Custom Alias | `customAlias:"gh-test"` | 201 + `customAlias:"gh-test"` |
| 18 | ✅ Shorten — With ttlDays | `ttlDays:30` | 201 + `expiresAt` ~30 days out |
| 19 | ✅ Shorten — All Fields | url + alias + ttlDays | 201 |
| 20 | ❌ No Auth | Authorization removed | 401 |
| 21 | ❌ Missing URL | `{}` | 400 |
| 22 | ❌ Non-HTTP Scheme | `url:"ftp://example.com/file"` | 400 |
| 23 | ❌ SSRF — Private IP | `url:"http://192.168.1.1/admin"` | 400 |
| 24 | ❌ SSRF — Localhost | `url:"http://localhost/secret"` | 400 |
| 25 | ❌ Reserved Alias: api | `customAlias:"api"` | 400 |
| 26 | ❌ Reserved Alias: admin | `customAlias:"admin"` | 400 |
| 27 | ❌ Alias Too Short | `customAlias:"ab"` | 400 |
| 28 | ❌ Alias With Space | `customAlias:"my alias"` | 400 |
| 29 | ❌ ttlDays = 0 | `ttlDays:0` | 400 |
| 30 | ❌ ttlDays = 366 | `ttlDays:366` | 400 |
| 31 | ❌ Duplicate Alias | `customAlias:"gh-test"` again | 409 |

### 7. Redirect (Day 4)

> **Requires "Follow redirects: OFF"** in Postman settings.

| # | Request | Notes | Expect |
|---|---|---|---|
| 32 | ✅ Redirect — Auto Short Code | `GET /{{short_code}}` (from #16) | 302 + `Location` header |
| 33 | ✅ Redirect — Custom Alias | `GET /gh-test` | 302 + `Location: https://github.com` |
| 34 | ❌ Redirect — Non-Existent | `GET /zzzzzzzz` | 404 |
| 35 | ❌ Redirect — Expired URL | Manual: set `expires_at` to past in Prisma Studio → send | 410 Gone |
| 36 | ❌ Redirect — Deleted URL | Manual: set `is_deleted=true` in Prisma Studio → send | 410 Gone |

> For #35 and #36: run `npx prisma studio` in `api/`, find the URL record, edit the field, then run the request.

---

## Error Envelope — Global Check

Every 4xx/5xx response is automatically checked at the collection level for:

```json
{ "error": "string", "success": undefined }
```

If a response leaks a stack trace, Prisma message, or `success: false` instead of the envelope, the collection-level test will fail and flag it.

---

## What "Run Collection" Doesn't Cover

These require manual steps before sending:

- **Refresh — No Cookie (#13):** Clear the cookie in Postman cookie manager first
- **Redirect — Expired (#35):** Set `expires_at` to a past timestamp via Prisma Studio
- **Redirect — Deleted (#36):** Set `is_deleted = true` via Prisma Studio

Everything else is fully automated.
