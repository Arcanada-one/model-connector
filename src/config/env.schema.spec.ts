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

  // TRANS-0035: speech proxy env vars
  it('should apply defaults for TRANS-0035 speech proxy', () => {
    const config = validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost/db' });
    expect(config.TRANSCRIBATOR_API_URL).toBe('http://localhost:3700');
    expect(config.SPEECH_INTERNAL_TOKEN).toBeUndefined();
    expect(config.SPEECH_PROXY_TIMEOUT_MS).toBe(30_000);
  });

  it('should accept custom TRANSCRIBATOR_API_URL and validated token', () => {
    const config = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      TRANSCRIBATOR_API_URL: 'https://api.transcribator.com',
      SPEECH_INTERNAL_TOKEN: 'a-secret-token-at-least-16-chars',
      SPEECH_PROXY_TIMEOUT_MS: '15000',
    });
    expect(config.TRANSCRIBATOR_API_URL).toBe('https://api.transcribator.com');
    expect(config.SPEECH_INTERNAL_TOKEN).toBe('a-secret-token-at-least-16-chars');
    expect(config.SPEECH_PROXY_TIMEOUT_MS).toBe(15_000);
  });

  it('should reject SPEECH_INTERNAL_TOKEN shorter than 16 chars', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        SPEECH_INTERNAL_TOKEN: 'short',
      }),
    ).toThrow('Invalid environment variables');
  });

  it('should reject invalid TRANSCRIBATOR_API_URL', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        TRANSCRIBATOR_API_URL: 'not-a-url',
      }),
    ).toThrow('Invalid environment variables');
  });
});
