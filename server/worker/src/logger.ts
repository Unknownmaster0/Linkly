import { pino } from 'pino';
import { getFastifyLoggerConfig } from '@url-shortener/shared';
import { config } from './config.js';

// Standalone pino logger for the worker process (no Fastify instance here).
// Reuses the shared logger config so dev/prod formatting matches the servers.
export const logger = pino(getFastifyLoggerConfig(config.NODE_ENV));
