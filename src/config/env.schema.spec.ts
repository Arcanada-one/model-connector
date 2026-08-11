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
  it('provides deterministic non-secret Vertex generative defaults', () => {
    const config = validateEnv(validEnv);
    expect(config.VERTEX_GENERATIVE_PROJECT).toBe('unconfigured-project');
    expect(config.VERTEX_GENERATIVE_LOCATION).toBe('us-central1');
    expect(config.VERTEX_GENERATIVE_MODELS).toBe('gemini-2.5-flash');
  });

  it('accepts explicit Vertex generative project, location and ordered models', () => {
    const config = validateEnv({
      ...validEnv,
      VERTEX_GENERATIVE_PROJECT: 'my-project',
      VERTEX_GENERATIVE_LOCATION: 'europe-west4',
      VERTEX_GENERATIVE_MODELS: 'gemini-2.5-flash,gemini-2.5-pro',
    });
    expect(config.VERTEX_GENERATIVE_PROJECT).toBe('my-project');
    expect(config.VERTEX_GENERATIVE_LOCATION).toBe('europe-west4');
    expect(config.VERTEX_GENERATIVE_MODELS).toBe('gemini-2.5-flash,gemini-2.5-pro');
  });
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

  // CONN-0244 — the default free cascade must be DEEP (≥5 live free rungs across ≥2 providers)
  // and must NOT route through the paid OpenModel gateway.
  it('default CASCADE_LOW_REASONING_ORDER is a deep multi-provider free chain, no openmodel', () => {
    const order = validateEnv(validEnv).CASCADE_LOW_REASONING_ORDER;
    expect(order).not.toMatch(/openmodel:/); // openmodel gone entirely (paid)
    const rungs = order.split(',');
    const freeRungs = rungs.filter((e) => e.endsWith(':free'));
    // depth: at least 5 genuinely-free rungs
    expect(freeRungs.length).toBeGreaterThanOrEqual(5);
    // provider diversity: free rungs span at least 2 distinct providers
    const providers = new Set(freeRungs.map((e) => e.split(':')[0]));
    expect(providers.size).toBeGreaterThanOrEqual(2);
    expect(providers.has('groq')).toBe(true);
    expect(providers.has('openrouter')).toBe(true);
    // fast, proven groq rung first; single paid rung stays last
    expect(rungs[0]).toBe('groq:llama-3.3-70b-versatile:free');
    expect(rungs[rungs.length - 1].endsWith(':paid')).toBe(true);
    // no model id contains a colon (would break tier parsing): each rung has exactly 2 colons
    expect(rungs.every((e) => e.split(':').length === 3)).toBe(true);
  });

  // CONN-0244 — OpenModel is a paid gateway kept visible but not routable by default.
  it('default PROVIDER_ACCESS marks openmodel read-only', () => {
    expect(validateEnv(validEnv).PROVIDER_ACCESS).toBe('openmodel:read');
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
    expect(config.GEMINI_API_KEY).toBeUndefined();
    expect(config.GEMINI_API_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(config.GEMINI_API_TIMEOUT_MS).toBe(120_000);
    expect(config.GEMINI_API_MAX_CONCURRENCY).toBe(10);
    expect(config.OPENROUTER_MAX_CONCURRENCY).toBe(10);
    expect(config.EMBEDDING_MAX_CONCURRENCY).toBe(8);
    expect(config.CIRCUIT_BREAKER_THRESHOLD).toBe(5);
    expect(config.CIRCUIT_BREAKER_COOLDOWN_MS).toBe(30_000);
    expect(config.BEDROCK_REGION).toBe('us-east-1');
    expect(config.BEDROCK_MODELS).toEqual([
      'amazon.nova-lite-v1:0',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    ]);
  });

  it('parses a deterministic configured Bedrock model list', () => {
    const config = validateEnv({
      ...validEnv,
      BEDROCK_REGION: 'eu-central-1',
      BEDROCK_MODELS: ' model/a:1,model-b, model/a:1 ,,model-c ',
    });
    expect(config.BEDROCK_REGION).toBe('eu-central-1');
    expect(config.BEDROCK_MODELS).toEqual(['model/a:1', 'model-b', 'model-c']);
  });

  it('rejects an invalid Bedrock region and empty model list', () => {
    expect(() => validateEnv({ ...validEnv, BEDROCK_REGION: '../metadata' })).toThrow(
      'Invalid environment variables',
    );
    expect(() => validateEnv({ ...validEnv, BEDROCK_MODELS: ' , ' })).toThrow(
      'Invalid environment variables',
    );
  });

  it('validates native Gemini API settings independently from Gemini CLI settings', () => {
    const config = validateEnv({
      ...validEnv,
      GEMINI_MAX_CONCURRENCY: '2',
      GEMINI_API_KEY: 'fixture-only',
      GEMINI_API_BASE_URL: 'https://gemini.invalid/v1beta',
      GEMINI_API_TIMEOUT_MS: '45000',
      GEMINI_API_MAX_CONCURRENCY: '7',
    });
    expect(config.GEMINI_MAX_CONCURRENCY).toBe(2);
    expect(config.GEMINI_API_KEY).toBe('fixture-only');
    expect(config.GEMINI_API_BASE_URL).toBe('https://gemini.invalid/v1beta');
    expect(config.GEMINI_API_TIMEOUT_MS).toBe(45_000);
    expect(config.GEMINI_API_MAX_CONCURRENCY).toBe(7);
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

  describe('Deepgram TTS configuration (CONN-0308)', () => {
    const tts = (overrides: Record<string, string>) => ({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      STT_GROQ_API_KEY: 'test-groq-key',
      ...overrides,
    });

    it('is default-off with the official HTTPS origin and bounded timeout', () => {
      const config = validateEnv(tts({}));
      expect(config.TTS_PROVIDER_DEEPGRAM_ENABLED).toBe(false);
      expect(config.TTS_DEEPGRAM_API_KEY).toBeUndefined();
      expect(config.TTS_DEEPGRAM_BASE_URL).toBe('https://api.deepgram.com');
      expect(config.TTS_DEEPGRAM_TIMEOUT_MS).toBe(30_000);
    });

    it('rejects enabled-without-key and accepts enabled-with-key', () => {
      expect(() => validateEnv(tts({ TTS_PROVIDER_DEEPGRAM_ENABLED: 'true' }))).toThrow(
        'TTS_DEEPGRAM_API_KEY required when TTS_PROVIDER_DEEPGRAM_ENABLED=true',
      );
      expect(() =>
        validateEnv(
          tts({
            TTS_PROVIDER_DEEPGRAM_ENABLED: 'true',
            TTS_DEEPGRAM_API_KEY: 'test-deepgram-key',
          }),
        ),
      ).not.toThrow();
    });

    it('rejects non-HTTPS origins and out-of-bounds timeouts', () => {
      expect(() => validateEnv(tts({ TTS_DEEPGRAM_BASE_URL: 'http://api.deepgram.com' }))).toThrow(
        'Invalid environment variables',
      );
      expect(() => validateEnv(tts({ TTS_DEEPGRAM_BASE_URL: 'https://example.test' }))).toThrow(
        'Invalid environment variables',
      );
      expect(() => validateEnv(tts({ TTS_DEEPGRAM_TIMEOUT_MS: '999' }))).toThrow(
        'Invalid environment variables',
      );
      expect(() => validateEnv(tts({ TTS_DEEPGRAM_TIMEOUT_MS: '120001' }))).toThrow(
        'Invalid environment variables',
      );
    });
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

  // CONN-0223 V-AC-10 — boot-guard: OpenModel + cascade paid-tier (plan Phase 2)
  describe('CONN-0223 boot-guard (V-AC-10)', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      STT_GROQ_API_KEY: 'test-groq-key',
    };

    // OpenModel guard
    it('rejects OPENMODEL_ENABLED=true without OPENMODEL_API_KEY', () => {
      expect(() => validateEnv({ ...base, OPENMODEL_ENABLED: 'true' })).toThrow(
        'Invalid environment variables',
      );
    });

    it('accepts OPENMODEL_ENABLED=true with OPENMODEL_API_KEY set', () => {
      expect(() =>
        validateEnv({ ...base, OPENMODEL_ENABLED: 'true', OPENMODEL_API_KEY: 'om-test-key' }),
      ).not.toThrow();
    });

    it('accepts OPENMODEL_ENABLED=false with no OPENMODEL_API_KEY (default off, fail-closed)', () => {
      const config = validateEnv(base);
      expect(config.OPENMODEL_ENABLED).toBe(false);
      expect(config.OPENMODEL_API_KEY).toBeUndefined();
    });

    // Paid-tier guard (V-AC-10 "paid tier likewise")
    it('rejects CASCADE_PAID_ENABLED=true without OPENROUTER_API_KEY', () => {
      expect(() => validateEnv({ ...base, CASCADE_PAID_ENABLED: 'true' })).toThrow(
        'Invalid environment variables',
      );
    });

    it('accepts CASCADE_PAID_ENABLED=true with OPENROUTER_API_KEY set', () => {
      expect(() =>
        validateEnv({ ...base, CASCADE_PAID_ENABLED: 'true', OPENROUTER_API_KEY: 'sk-or-test' }),
      ).not.toThrow();
    });

    it('accepts CASCADE_PAID_ENABLED=false with no OPENROUTER_API_KEY (default off)', () => {
      const config = validateEnv(base);
      expect(config.CASCADE_PAID_ENABLED).toBe(false);
    });
  });

  describe('Together Orpheus TTS configuration', () => {
    const base = {
      DATABASE_URL: 'postgresql://test',
      STT_GROQ_API_KEY: 'placeholder',
    };

    it('is default-off with the current .ai URL and bounded timeout', () => {
      const config = validateEnv(base);
      expect(config.TTS_PROVIDER_TOGETHER_ENABLED).toBe(false);
      expect(config.TOGETHER_API_KEY).toBeUndefined();
      expect(config.TOGETHER_BASE_URL).toBe('https://api.together.ai/v1');
      expect(config.TTS_TOGETHER_TIMEOUT_MS).toBe(60_000);
    });

    it('parses the literal false as false', () => {
      expect(
        validateEnv({ ...base, TTS_PROVIDER_TOGETHER_ENABLED: 'false' })
          .TTS_PROVIDER_TOGETHER_ENABLED,
      ).toBe(false);
    });

    it('rejects explicit enablement without a Together key', () => {
      expect(() => validateEnv({ ...base, TTS_PROVIDER_TOGETHER_ENABLED: 'true' })).toThrow(
        'Invalid environment variables',
      );
    });

    it('accepts explicit enablement with a non-empty key slot', () => {
      expect(() =>
        validateEnv({
          ...base,
          TTS_PROVIDER_TOGETHER_ENABLED: 'true',
          TOGETHER_API_KEY: 'placeholder',
        }),
      ).not.toThrow();
    });
  });
});
