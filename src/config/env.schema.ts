import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.coerce.number().default(3900),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_PREFIX: z.string().default('conn:'),

  API_KEY_SALT_ROUNDS: z.coerce.number().min(4).max(14).default(10),

  CONNECTOR_TIMEOUT_MS: z.coerce.number().min(5_000).max(600_000).default(120_000),
  CONNECTOR_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
  CONNECTOR_QUEUE_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(60_000),
  CONNECTOR_MAX_RETRIES: z.coerce.number().min(0).max(5).default(1),

  CLAUDE_CODE_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
  CURSOR_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(1),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
  OPENROUTER_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
  EMBEDDING_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(8),

  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().min(1).max(50).default(5),
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().min(1_000).max(300_000).default(30_000),

  EMBEDDING_API_URL: z.string().url().default('http://100.70.137.104:8300'),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),

  ADMIN_TOKEN: z.string().min(32).optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedConfig: EnvConfig | null = null;

export function validateEnv(env: Record<string, unknown> = process.env): EnvConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }
  cachedConfig = result.data;
  return result.data;
}

export function getConfig(): EnvConfig {
  if (!cachedConfig) {
    return validateEnv();
  }
  return cachedConfig;
}
