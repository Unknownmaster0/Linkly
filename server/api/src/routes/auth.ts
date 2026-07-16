import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { createAuthService } from '../services/auth.service.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import {
  registerBodySchema,
  loginBodySchema,
  deleteAccountBodySchema,
} from '../schemas/auth.schema.js';
import { successResponse } from '../utils/api-response.js';
import { config } from '../config.js';
import { AuthError, ValidationError } from '../utils/errors.js';
import {
  zodToJsonSchema,
  successEnvelope,
  errorEnvelope,
  noContentResponse,
} from '../utils/openapi.js';

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI schemas (docs only — see plugins/swagger.ts; Zod stays the validator)
// ─────────────────────────────────────────────────────────────────────────────

const authResultData = {
  type: 'object',
  properties: {
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'cuid_user_id' },
        email: { type: 'string', format: 'email', example: 'user@example.com' },
      },
    },
    accessToken: { type: 'string', description: 'JWT access token (15-min expiry)' },
  },
} as const;

const registerSchema = {
  tags: ['Auth'],
  summary: 'Register a new user',
  description:
    'Creates an account and returns an access token plus a `refreshToken` httpOnly ' +
    'cookie. Password must be 8–128 chars with at least one uppercase, one ' +
    'lowercase, and one number; `confirmPassword` must equal `password`.\n\n' +
    'Rate limited per IP (see `X-RateLimit-*` response headers).',
  body: zodToJsonSchema(registerBodySchema),
  response: {
    201: successEnvelope(authResultData, 'Registration successful'),
    400: errorEnvelope('Validation failed', { error: 'Passwords do not match', details: { field: 'confirmPassword' } }),
    409: errorEnvelope('Email already registered', { error: 'Email already registered', details: { field: 'email' } }),
    429: errorEnvelope('Rate limit exceeded', { error: 'Rate limit exceeded', retryAfter: 60 }),
  },
};

const loginSchema = {
  tags: ['Auth'],
  summary: 'Log in',
  description:
    'Authenticates a user and returns an access token plus a refreshed ' +
    '`refreshToken` httpOnly cookie. A single generic 401 is used for both ' +
    'unknown email and wrong password (no user enumeration).\n\n' +
    'Rate limited per IP (see `X-RateLimit-*` response headers).',
  body: zodToJsonSchema(loginBodySchema),
  response: {
    200: successEnvelope(authResultData, 'Login successful'),
    401: errorEnvelope('Invalid credentials', { error: 'Invalid email or password' }),
    429: errorEnvelope('Rate limit exceeded', { error: 'Rate limit exceeded', retryAfter: 60 }),
  },
};

const refreshSchema = {
  tags: ['Auth'],
  summary: 'Refresh the access token',
  description:
    'Issues a new access token and rotates the refresh token. Uses the ' +
    '`refreshToken` httpOnly cookie automatically sent by the browser — no body ' +
    'or Authorization header required.',
  security: [{ cookieAuth: [] }],
  response: {
    200: successEnvelope(authResultData, 'Token refreshed'),
    401: errorEnvelope('Refresh token missing, invalid, expired, or revoked', { error: 'Unauthorized' }),
  },
};

const logoutSchema = {
  tags: ['Auth'],
  summary: 'Log out',
  description: 'Revokes the refresh token and clears the cookie. Requires a valid access token.',
  security: [{ bearerAuth: [] }],
  response: {
    204: noContentResponse,
    401: errorEnvelope('Not authenticated', { error: 'Unauthorized' }),
  },
};

const deleteAccountSchema = {
  tags: ['Auth'],
  summary: 'Delete account',
  description:
    'Anonymizes the account (email, name, and password are overwritten and the account ' +
    'is deactivated) and soft-deletes every URL the user owns. Click-event history for ' +
    'those URLs is preserved, per the soft-delete policy. Requires the current password ' +
    'plus a valid access token; clears the refresh cookie on success.',
  security: [{ bearerAuth: [] }],
  body: zodToJsonSchema(deleteAccountBodySchema),
  response: {
    204: noContentResponse,
    401: errorEnvelope('Invalid password or not authenticated', { error: 'Invalid password' }),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Cookie helpers — no @fastify/cookie dependency needed for basic httpOnly usage
// ─────────────────────────────────────────────────────────────────────────────

function parseCookies(request: FastifyRequest): Record<string, string> {
  const header = request.headers['cookie'] ?? '';
  const result: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

function setRefreshCookie(reply: FastifyReply, token: string): void {
  // Fail-safe, not fail-open: only the explicit 'development' value drops the
  // Secure flag. If NODE_ENV is ever left unset in a real deployment, it falls
  // back to the shared config's 'development' default — but that must NOT
  // silently downgrade cookie security, so every other value (production,
  // test, or unset-and-defaulted) keeps Secure on.
  const secure = config.NODE_ENV === 'development' ? '' : '; Secure';
  reply.header(
    'Set-Cookie',
    `refreshToken=${token}; HttpOnly; SameSite=Strict; Max-Age=${REFRESH_COOKIE_MAX_AGE}; Path=/${secure}`
  );
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', 'refreshToken=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Pre-auth brute-force guards — keyed by IP, since neither endpoint has a
// userId yet at this point. Limits per production security requirements.
const loginRateLimit = makeRateLimiter({
  key: (request: FastifyRequest) => `rl:login:${request.ip}`,
  limit: config.RATE_LIMIT_LOGIN_LIMIT,
  windowSecs: config.RATE_LIMIT_LOGIN_WINDOW_SECS,
});

const registerRateLimit = makeRateLimiter({
  key: (request: FastifyRequest) => `rl:register:${request.ip}`,
  limit: config.RATE_LIMIT_REGISTER_LIMIT,
  windowSecs: config.RATE_LIMIT_REGISTER_WINDOW_SECS,
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const authService = createAuthService(app.prisma);

  // POST /api/auth/register
  app.post('/register', { preHandler: [registerRateLimit], schema: registerSchema }, async (request, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(issue?.message ?? 'Validation failed', { field: issue?.path[0] });
    }

    const { email, password, name } = parsed.data;
    const userAgent = request.headers['user-agent'] ?? '';

    const result = await authService.register(email, password, name, userAgent);

    setRefreshCookie(reply, result.refreshToken);
    return reply.status(201).send(
      successResponse('Registration successful', {
        user: result.user,
        accessToken: result.accessToken,
      })
    );
  });

  // POST /api/auth/login
  app.post('/login', { preHandler: [loginRateLimit], schema: loginSchema }, async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(issue?.message ?? 'Validation failed', { field: issue?.path[0] });
    }

    const { email, password } = parsed.data;
    const userAgent = request.headers['user-agent'] ?? '';

    const result = await authService.login(email, password, userAgent);

    setRefreshCookie(reply, result.refreshToken);
    return reply.status(200).send(
      successResponse('Login successful', {
        user: result.user,
        accessToken: result.accessToken,
      })
    );
  });

  // POST /api/auth/refresh — uses httpOnly cookie, no access token needed
  app.post('/refresh', { schema: refreshSchema }, async (request, reply) => {
    const cookies = parseCookies(request);
    const tokenValue = cookies['refreshToken'];

    if (!tokenValue) {
      throw new AuthError('Unauthorized');
    }

    const userAgent = request.headers['user-agent'] ?? '';
    const result = await authService.refresh(tokenValue, userAgent);

    setRefreshCookie(reply, result.refreshToken);
    return reply.status(200).send(
      successResponse('Token refreshed', {
        user: result.user,
        accessToken: result.accessToken,
      })
    );
  });

  // POST /api/auth/logout — requires valid access token
  app.post('/logout', { preHandler: [authenticate], schema: logoutSchema }, async (request, reply) => {
    const cookies = parseCookies(request);
    const tokenValue = cookies['refreshToken'];

    if (tokenValue) {
      await authService.logout(request.userId, tokenValue);
    }

    clearRefreshCookie(reply);
    return reply.status(204).send();
  });

  // DELETE /api/auth/account — requires a valid access token + current password
  app.delete('/account', { preHandler: [authenticate], schema: deleteAccountSchema }, async (request, reply) => {
    const parsed = deleteAccountBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(issue?.message ?? 'Validation failed', { field: issue?.path[0] });
    }

    await authService.deleteAccount(request.userId, parsed.data.password);

    clearRefreshCookie(reply);
    return reply.status(204).send();
  });
}
