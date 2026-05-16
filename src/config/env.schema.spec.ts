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
  // CONN-0103 — Groq enabled by default; refine requires key when enabled.
  STT_GROQ_API_KEY: 'test-groq-key',
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
    const config = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      STT_GROQ_API_KEY: 'test-groq-key',
    });
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
    const config = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      STT_GROQ_API_KEY: 'test-groq-key',
    });
    expect(config.TRANSCRIBATOR_API_URL).toBe('http://localhost:3700');
    expect(config.SPEECH_INTERNAL_TOKEN).toBeUndefined();
    expect(config.SPEECH_PROXY_TIMEOUT_MS).toBe(30_000);
  });

  it('should accept custom TRANSCRIBATOR_API_URL and validated token', () => {
    const config = validateEnv({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      STT_GROQ_API_KEY: 'test-groq-key',
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
        STT_GROQ_API_KEY: 'test-groq-key',
        SPEECH_INTERNAL_TOKEN: 'short',
      }),
    ).toThrow('Invalid environment variables');
  });

  it('should reject invalid TRANSCRIBATOR_API_URL', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        STT_GROQ_API_KEY: 'test-groq-key',
        TRANSCRIBATOR_API_URL: 'not-a-url',
      }),
    ).toThrow('Invalid environment variables');
  });

  // CONN-0103 remediation — V-AC-8 conditional refine:
  // STT_PROVIDER_{NAME}_ENABLED=true ⇒ STT_{NAME}_API_KEY required.
  describe('STT provider conditional refine (CONN-0103 V-AC-8)', () => {
    const stt = (overrides: Record<string, string>) => ({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      STT_GROQ_API_KEY: 'test-groq-key',
      ...overrides,
    });

    it('rejects STT_PROVIDER_DEEPGRAM_ENABLED=true without STT_DEEPGRAM_API_KEY', () => {
      expect(() => validateEnv(stt({ STT_PROVIDER_DEEPGRAM_ENABLED: 'true' }))).toThrow(
        'Invalid environment variables',
      );
    });

    it('rejects STT_PROVIDER_ASSEMBLYAI_ENABLED=true without STT_ASSEMBLYAI_API_KEY', () => {
      expect(() => validateEnv(stt({ STT_PROVIDER_ASSEMBLYAI_ENABLED: 'true' }))).toThrow(
        'Invalid environment variables',
      );
    });

    it('rejects STT_PROVIDER_OPENAI_ENABLED=true without STT_OPENAI_API_KEY', () => {
      expect(() => validateEnv(stt({ STT_PROVIDER_OPENAI_ENABLED: 'true' }))).toThrow(
        'Invalid environment variables',
      );
    });

    it('rejects STT_PROVIDER_GROQ_ENABLED=true without STT_GROQ_API_KEY or GROQ_API_KEY', () => {
      expect(() =>
        validateEnv({
          DATABASE_URL: 'postgresql://u:p@localhost/db',
          STT_PROVIDER_GROQ_ENABLED: 'true',
        }),
      ).toThrow('Invalid environment variables');
    });

    it('accepts STT_PROVIDER_DEEPGRAM_ENABLED=true with STT_DEEPGRAM_API_KEY set', () => {
      expect(() =>
        validateEnv(
          stt({
            STT_PROVIDER_DEEPGRAM_ENABLED: 'true',
            STT_DEEPGRAM_API_KEY: 'dg-test-key',
          }),
        ),
      ).not.toThrow();
    });

    it('accepts STT_PROVIDER_GROQ_ENABLED=true with legacy GROQ_API_KEY fallback', () => {
      expect(() =>
        validateEnv(
          stt({
            STT_PROVIDER_GROQ_ENABLED: 'true',
            GROQ_API_KEY: 'groq-legacy-key',
          }),
        ),
      ).not.toThrow();
    });

    it('default (all disabled) parses cleanly with no keys', () => {
      const config = validateEnv(stt({}));
      expect(config.STT_PROVIDER_DEEPGRAM_ENABLED).toBe(false);
      expect(config.STT_PROVIDER_ASSEMBLYAI_ENABLED).toBe(false);
      expect(config.STT_PROVIDER_OPENAI_ENABLED).toBe(false);
    });
  });
});
