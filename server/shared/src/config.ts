import { z } from 'zod';

const commonEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  VALKEY_URL:   z.string().min(1, 'VALKEY_URL is required'),
  NODE_ENV:     z.enum(['development', 'production', 'test']).default('development'),
  // Hard ceiling (ms) for graceful shutdown before the process force-exits.
  // Must stay under the orchestrator's SIGTERM→SIGKILL window (k8s default 30 s).
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type CommonConfig = z.infer<typeof commonEnvSchema>;

export function getCommonConfig(): CommonConfig {
  return commonEnvSchema.parse({
    DATABASE_URL: process.env['DATABASE_URL'],
    VALKEY_URL:   process.env['VALKEY_URL'],
    NODE_ENV:     process.env['NODE_ENV'],
    SHUTDOWN_TIMEOUT_MS: process.env['SHUTDOWN_TIMEOUT_MS'],
  });
}
