# Security Reviewer Skill for URL Shortener

This skill helps conduct security reviews of the URL shortener project by identifying potential vulnerabilities, privacy concerns, and security misconfigurations based on the system design documentation.

## When to Use This Skill

Use this skill when:
- Reviewing code for security vulnerabilities before merging
- Conducting security audits of the URL shortener implementation
- Checking for compliance with security best practices documented in the design
- Identifying potential data exposure or privacy issues
- Verifying authentication and authorization implementations
- Reviewing rate limiting and abuse prevention mechanisms
- Checking for secure handling of sensitive data

## Key Security Areas to Review

Based on the system design documentation, here are the critical security areas that need review:

### 1. Authentication & Authorization
- **JWT Implementation**: Access tokens (15-min expiry) + refresh tokens (HTTP-only cookies, 30-day expiry, stored in DB for revocation)
- **Password Security**: Argon2id hashing (never plaintext or bcrypt), minimum 8 chars with letter+number requirement
- **Auth Endpoints**: 
  - Registration: Email validation, password strength, confirmPassword matching
  - Login: Do NOT distinguish between "email not found" vs "wrong password" (security)
  - Refresh: Validate refreshToken cookie, issue new tokens
  - Logout: Require auth, revoke refreshToken, clear cookie
- **Ownership Verification**: All user-specific endpoints must verify ownership

### 2. Information Leakage Prevention (Critical)
- **Ownership Checks**: Always return 404 (not 403) for both "resource doesn't exist" and "user doesn't own it"
- **Error Responses**: Never expose whether a resource exists but is inaccessible
- **Specific Endpoints**: 
  - GET /api/urls/:shortCode (analytics)
  - DELETE /api/urls/:shortCode
  - Any user-specific resource access

### 3. Input Validation & Sanitization
- **URL Validation**: Must validate http/https format, prevent javascript: and data: URIs
- **Alias Validation**: Alphanumeric + hyphen only, 3-50 chars, reserved words check (api, health, docs, admin, static)
- **Email Validation**: Proper email format validation
- **Password Validation**: Minimum length, complexity requirements
- **TTL Validation**: Integer 1-365 range check
- **SQL Injection Prevention**: Parameterized queries/ORM usage
- **XSS Prevention**: Proper output encoding, Content-Security-Policy headers

### 4. Rate Limiting & Abuse Prevention
- **Creation Endpoint**: 100 URLs per user per hour (authenticated)
- **Redirect Endpoint**: Rate limit unauthenticated requests (anti-bot, 10/min per IP suggested)
- **Login Endpoint**: Per-IP + per-account rate limiting
- **Fail-Open Design**: When rate limiter (Valkey) is down, allow requests (prefer availability over perfect rate limiting)
- **Enumeration Protection**: 
  - Don't use sequential short codes that reveal counts
  - Use shuffled Base62 encoding or add random component
  - Rate limit short code guessing attempts

### 5. Data Protection & Privacy
- **IP Address Handling**: Store SHA-256(IP + daily_salt), never raw IP (GDPR/privacy)
- **Analytics Data**: 
  - Raw click events stored 90 days, then aggregated/purged
  - IP addresses never returned in API responses (stored hashed only)
  - Referrer domains only (not full URLs to avoid path data exposure)
- **Sensitive Fields**: Never return passwords, tokens, hashes in responses
- **Refresh Tokens**: Store as SHA-256 hash in DB, never raw token

### 6. Secure Defaults & Headers
- **HTTP Security Headers**: 
  - Content-Security-Policy
  - X-Frame-Options
  - Strict-Transport-Security (HSTS)
  - X-Content-Type-Options
  - Referrer-Policy
- **Cookie Security**: 
  - HttpOnly, Secure, SameSite=Strict for auth cookies
  - Proper expiration and clearing on logout
- **Cache Control**: 
  - Redirect responses: Cache-Control: no-cache (for accurate analytics)
  - API responses: Appropriate cache headers

### 7. Infrastructure Security
- **Database Connections**: 
  - Use connection limits and timeouts
  - Never expose connection strings in errors/logs
  - Use environment variables for secrets (never in code/repo)
- **Secrets Management**: 
  - JWT secrets, API keys in environment variables
  - Regular rotation procedures
  - Never commit secrets to version control
- **Error Handling**: 
  - 5xx errors: Generic messages only (no stack traces or internals)
  - Logging: Full errors in logs (for ops), sanitized responses to clients
  - Never expose Prisma messages, database details, or environment variables

### 8. Analytics Pipeline Security
- **Async Processing**: Click events fire-and-forget to BullMQ queue
- **Worker Security**: 
  - Validate job payloads before processing
  - Handle malformed data gracefully
  - Secure API keys for external services (geo lookup)
  - Rate limit external API calls
- **Data Enrichment**: 
  - Geo lookup failures: fallback to null, don't fail the job
  - User-Agent parsing: sanitize before storage/use

### 9. Specific Vulnerabilities to Check For
- **IDOR (Insecure Direct Object Reference)**: 
  - All user-owned resource endpoints must scope queries by userId
  - Never rely on separate existence + ownership checks
- **Race Conditions**: 
  - Check for TOCTOU issues in URL creation/update/deletion
  - Verify proper handling of expire/delete race conditions
- **Credential Stuffing**: 
  - Login endpoint rate limiting
  - Consider password breach checking
- **URL Safety**: 
  - Async Safe Browsing check on creation
  - Flag malicious URLs, return 451 on redirect
- **Token Security**: 
  - JWT algorithm validation (prefer HS256/RS256, reject "none")
  - Refresh token rotation on use
  - Access token short expiration (15 minutes)

### 10. Security Headers & Protections
Implement these middleware protections:
- **helmet** or equivalent for standard security headers
- **CORS configuration** (restrict origins if needed)
- **Request size limits** (prevent DoS via large payloads)
- **Timeout middleware** (prevent hanging connections)
- **CSRF protection** (if using cookies for auth in browser contexts)

## Security Review Checklist

### Authentication & Session Management
- [ ] Passwords hashed with Argon2id (not md5, sha1, or bcrypt)
- [ ] Access tokens: JWT with 15-minute expiry
- [ ] Refresh tokens: HTTP-only cookies, stored as hashes in DB, 30-day expiry
- [ ] Logout properly revokes refresh tokens and clears cookies
- [ ] Login does NOT distinguish between "user not found" and "wrong password"
- [ ] Token refresh validates existing refresh token before issuing new ones
- [ ] JWT secret is strong and stored in environment variables
- [ ] Refresh token secret is different from access token secret

### Input Validation
- [ ] All request bodies validated against strict schemas
- [ ] URL validation rejects javascript:, data:, and other dangerous protocols
- [ ] Custom alias validation: alphanumeric + hyphen, 3-50 chars
- [ ] Reserved words blocked: api, health, docs, admin, static
- [ ] Email format validation
- [ ] Password: min 8 chars, requires letter + number
- [ ] TTL: integer between 1-365
- [ ] All user input treated as untrusted

### Authorization & Access Control
- [ ] All user-specific endpoints verify ownership
- [ ] Ownership checks use scoped queries (WHERE shortCode = ? AND userId = ?)
- [ ] Ownership failures return 404 (not 403) to prevent information leakage
- [ ] No endpoints leak existence of resources through error messages
- [ ] Anonymous users can only access public redirect endpoint
- [ ] Admin-like functionality properly restricted

### Rate Limiting & Abuse Prevention
- [ ] URL creation: 100 per user per hour (authenticated)
- [ ] Login attempts: rate limited by IP and/or account
- [ ] Redirect endpoint: rate limit unauthenticated requests (anti-bot)
- [ ] Rate limiter fails open when Valkey/Redis is unavailable
- [ ] Short code enumeration protected via encoding/shuffling + rate limits
- [ ] Malicious URL detection (Safe Browsing API async check)

### Data Protection & Privacy
- [ ] IP addresses stored as SHA-256(IP + daily_salt), never raw
- [ ] Raw IP never returned in API responses
- [ ] Referrer data stored as domain only (not full URLs)
- [ ] Click events purged/aggregated after 90 days
- [ ] Analytics endpoints require authentication and ownership verification
- [ ] No sensitive data (passwords, tokens) in logs or error responses
- [ ] Database connection strings never exposed in errors

### Error Handling & Logging
- [ ] 5xx errors return generic messages only (no stack traces or internals)
- [ ] 400/4xx errors include helpful but safe details
- [ ] Ownership verification failures return 404 (identical to not-found)
- [ ] Error logs contain full details for debugging (but not in responses)
- [ ] No Prisma/database details exposed to API consumers
- [ ] Structured logging with request IDs for traceability
- [ ] Sensitive fields (passwords, tokens, IPs) never logged in plaintext

### Infrastructure & Configuration
- [ ] Secrets stored in environment variables, never in code/repo
- [ ] Database connection uses appropriate limits and timeouts
- [ ] Connection pool sizing appropriate for environment
- [ ] Valkey/Redis used for caching and rate limiting with proper TTLs
- [ ] Health check endpoint exposes minimal system status
- [ ] No debug endpoints exposed in production
- [ ] Dependency versions checked for known vulnerabilities

### Specific Security Features
- [ ] Redirect uses 302 (not 301) to preserve analytics accuracy
- [ ] Async analytics pipeline: redirect response sent before click processing
- [ ] Cache invalidation on URL updates/deletes
- [ ] Negative caching for deleted URLs (30s TTL) to prevent thundering herd
- [ ] Lazy expiry check at redirect time (return 410 if expired)
- [ ] Click worker discards P2003 errors (URL gone) without retry
- [ ] Geo lookup failures fall back to null without failing the job
- [ ] Structured error responses following ERROR_CONTRACT.md
- [ ] Rate limit headers (X-RateLimit-*) on all 2xx responses

## Files to Review for Security

When conducting a security review, focus on these areas:

### Authentication Files
- `src/api/routes/auth/` - Auth endpoint implementations
- `src/api/middleware/authenticate.js` - JWT validation middleware
- `src/shared/services/authService.js` - Auth business logic
- `src/shared/errors/` - Custom error classes (AuthError, etc.)
- `src/config/jwt.js` - JWT configuration

### URL Management Files
- `src/api/routes/urls/` - URL CRUD endpoints
- `src/api/middleware/ownership.js` - Ownership verification middleware
- `src/shared/services/urlService.js` - URL business logic
- `src/shared/utils/validation.js` - Input validation utilities

### Redirect & Analytics Files
- `src/redirect/` - Redirect server implementation
- `src/jobs/clickProcessor.js` - BullMQ worker for click events
- `src/api/routes/analytics/` - Analytics endpoints
- `src/shared/services/analyticsService.js` - Analytics business logic

### Middleware & Utilities
- `src/api/middleware/validation.js` - Request validation middleware
- `src/api/middleware/rateLimit.js` - Rate limiting implementation
- `src/api/middleware/securityHeaders.js` - Security headers middleware
- `src/shared/utils/logger.js` - Logging implementation
- `src/shared/utils/crypto.js` - Hashing/encryption utilities

### Configuration Files
- `src/config/` - Environment-specific configurations
- `.env.example` - Required environment variables
- `prisma/schema.prisma` - Database schema (check for security-relevant fields)

### Error Handling
- `src/app.js` - Global error handler registration
- `src/shared/errors/globalErrorHandler.js` - Centralized error handling
- `src/shared/errors/customErrors.js` - Custom error class definitions

## Security Testing Guidelines

When reviewing, check for these specific test cases:

### Authentication Tests
- Invalid JWT tokens return 401
- Expired tokens return 401 (with refresh token flow working)
- Missing auth headers return 401
- Login with invalid credentials returns generic 401
- Registration with existing email returns 409 (generic message)
- Password reset/change requires proper authentication

### Authorization Tests
- User A cannot access User B's URLs (returns 404, not 403)
- User A cannot delete User B's URLs (returns 404)
- User A cannot view analytics for User B's URLs (returns 404)
- Unauthenticated requests to protected endpoints return 401
- Ownership verification works correctly for custom aliases

### Input Validation Tests
- Malformed URLs (javascript:, data: URIs) rejected
- Invalid email formats rejected
- Weak passwords (too short, missing letter/number) rejected
- Invalid custom aliases (special chars, too short/long) rejected
- Invalid TTL values (non-integer, out of range) rejected
- SQL injection attempts handled safely
- XSS payloads in input properly escaped/encoded

### Rate Limiting Tests
- Authenticated user limited to 100 URL creations/hour
- IP-based rate limiting on redirect endpoint (if implemented)
- Login attempt rate limiting by IP/account
- Proper 429 responses with Retry-After headers
- Rate limiter fails open when backend unavailable

### Information Leakage Tests
- Attempt to access non-existent URL returns 404
- Attempt to access owned-but-not-authenticated URL returns 404 (same response)
- Error messages don't reveal whether resource exists or not
- No timing differences between exist/not-exist responses
- Admin endpoints properly protected (if any exist)

### Data Exposure Tests
- API responses never contain raw passwords or hashes
- Tokens only appear in auth endpoints (not in URL management)
- IP addresses never returned in analytics responses
- Referrer data limited to domain level
- Database connection strings never in error responses
- Environment variable names/values never exposed

This security reviewer skill helps ensure the URL shortener implementation follows security best practices and prevents common vulnerabilities identified in the system design documentation.