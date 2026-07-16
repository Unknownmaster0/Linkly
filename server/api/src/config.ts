import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load this package's own .env by absolute path, so env-loading is independent
// of the directory the process is launched from (e.g. `server/` vs `server/api/`).
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

import { getCommonConfig } from '@url-shortener/shared';

const common = getCommonConfig();

// No hardcoded fallback: a guessable default would let anyone who has read this
// (public) source forge valid access/refresh tokens against any deployment that
// forgot to set the real secret.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  ...common,
  JWT_SECRET:              requireEnv('JWT_SECRET'),
  JWT_REFRESH_SECRET:      requireEnv('JWT_REFRESH_SECRET'),
  BASE_URL:                process.env['BASE_URL']                ?? 'http://localhost:3000',
  REDIRECT_URL:            process.env['REDIRECT_URL']            ?? 'http://localhost:3001',
  // Comma-separated allow-list of browser origins permitted by CORS. Never '*'
  // because the API sends credentials (httpOnly refresh cookie + Authorization).
  CLIENT_ORIGINS:          (process.env['CLIENT_ORIGINS']         ?? 'http://localhost:3002')
                             .split(',')
                             .map((o) => o.trim())
                             .filter((o) => o.length > 0),
  PORT:                    parseInt(process.env['PORT']           ?? '3000', 10),
  DEFAULT_URL_TTL_DAYS:    parseInt(process.env['DEFAULT_URL_TTL_DAYS'] ?? '7', 10),
  // 100 URLs/user/hour per API_CONTRACT.md — the contract is locked, so this
  // config conforms to it (it previously drifted to 10/60s = 600/hour, a 6x
  // looser ceiling than documented).
  RATE_LIMIT_CREATE_LIMIT: parseInt(process.env['RATE_LIMIT_CREATE_LIMIT'] ?? '100', 10),
  RATE_LIMIT_WINDOW_SECS:  parseInt(process.env['RATE_LIMIT_WINDOW_SECS']  ?? '3600', 10),
  // Brute-force / credential-stuffing guards — keyed by IP since the caller
  // isn't authenticated yet at this point.
  RATE_LIMIT_LOGIN_LIMIT:     parseInt(process.env['RATE_LIMIT_LOGIN_LIMIT']     ?? '5', 10),
  RATE_LIMIT_LOGIN_WINDOW_SECS: parseInt(process.env['RATE_LIMIT_LOGIN_WINDOW_SECS'] ?? '60', 10),
  // Per-ACCOUNT guard (keyed by the submitted email, not IP): closes the gap
  // where a distributed attacker (many source IPs) can credential-stuff one
  // victim account without limit, since the per-IP bucket above is scoped to
  // the attacker's own IP, not the target account.
  RATE_LIMIT_LOGIN_ACCOUNT_LIMIT:     parseInt(process.env['RATE_LIMIT_LOGIN_ACCOUNT_LIMIT']     ?? '10', 10),
  RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECS: parseInt(process.env['RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECS'] ?? '900', 10),
  RATE_LIMIT_REGISTER_LIMIT:  parseInt(process.env['RATE_LIMIT_REGISTER_LIMIT']  ?? '5', 10),
  RATE_LIMIT_REGISTER_WINDOW_SECS: parseInt(process.env['RATE_LIMIT_REGISTER_WINDOW_SECS'] ?? '60', 10),
};
