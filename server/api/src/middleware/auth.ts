import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AuthError } from '../utils/errors.js';

interface JwtPayload {
  userId: string;
  iat?: number;
  exp?: number;
}

export async function authenticate(request: FastifyRequest): Promise<void> {
  // Errors are thrown as AuthError and shaped by the global handler in app.ts,
  // which also attaches the `WWW-Authenticate` header to every 401 response.
  const authHeader = request.headers['authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    throw new AuthError('Unauthorized');
  }

  const token = authHeader.slice(7);
  let payload: JwtPayload;

  try {
    // Pin the expected algorithm. Access tokens are signed with HS256 (jsonwebtoken's
    // default for a symmetric secret in signAccessToken). Without this pin, verify()
    // accepts any algorithm the token's own header declares — defense-in-depth against
    // `alg:none` and algorithm-confusion forgeries.
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AuthError('Access token expired');
    }
    throw new AuthError('Unauthorized');
  }

  if (typeof payload.userId !== 'string' || !payload.userId) {
    throw new AuthError('Unauthorized');
  }

  request.userId = payload.userId;

  // Bind userId to this request's logger so the automatic "request completed"
  // line (and any handler log) carries it. The user id is an opaque identifier,
  // not PII — unlike the email/raw-IP that must never be logged.
  request.log = request.log.child({ userId: payload.userId });
}
