import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.schema';

const validEnv = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_TIMEOUT_MS: '300000',
  CONNECTOR_MAX_CONCURRENCY: '1',
};

describe('envSchema', () => {
  it('should parse valid env', () => {
    const config = validateEnv(validEnv);
    expect(config.PORT).toBe(3900);
    expect(config.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/test');
    expect(config.CONNECTOR_TIMEOUT_MS).toBe(300_000);
  });

  it('should throw on missing DATABASE_URL', () => {
    const { DATABASE_URL: _url, ...incomplete } = validEnv;
    expect(() => validateEnv(incomplete)).toThrow('Invalid environment variables');
  });

  it('should apply defaults for optional fields', () => {
    const config = validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost/db' });
    expect(config.PORT).toBe(3900);
    expect(config.NODE_ENV).toBe('development');
    expect(config.REDIS_HOST).toBe('127.0.0.1');
    expect(config.CONNECTOR_MAX_CONCURRENCY).toBe(4);
    expect(config.CONNECTOR_QUEUE_TIMEOUT_MS).toBe(60_000);
    expect(config.CONNECTOR_MAX_RETRIES).toBe(1);
    expect(config.CLAUDE_CODE_MAX_CONCURRENCY).toBe(4);
    expect(config.CURSOR_MAX_CONCURRENCY).toBe(1);
    expect(config.GEMINI_MAX_CONCURRENCY).toBe(4);
    expect(config.OPENROUTER_MAX_CONCURRENCY).toBe(10);
    expect(config.EMBEDDING_MAX_CONCURRENCY).toBe(8);
    expect(config.CIRCUIT_BREAKER_THRESHOLD).toBe(5);
    expect(config.CIRCUIT_BREAKER_COOLDOWN_MS).toBe(30_000);
  });
});
