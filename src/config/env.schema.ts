import { z } from 'zod';

// CONN-0102: z.coerce.boolean() coerces ANY non-empty string to `true`
// (including the literal "false"). For env flags where operators set
// `FOO=false` and expect false, we need explicit parsing.
const envBool = z.union([z.boolean(), z.string()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  const lower = v.trim().toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === '') return false;
  return true;
});

export const envSchema = z
  .object({
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

    // CONN-0089 output-guard middleware
    OUTPUT_GUARD_ENABLED: z.coerce.boolean().default(true),
    OUTPUT_GUARD_MAX_RETRIES: z.coerce.number().min(0).max(5).default(3),
    OUTPUT_GUARD_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),

    CLAUDE_CODE_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    CURSOR_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(1),
    GEMINI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    CODEX_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    OPENROUTER_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    GROQ_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    GROK_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    EMBEDDING_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(8),

    CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().min(1).max(50).default(5),
    CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().min(1_000).max(300_000).default(30_000),

    EMBEDDING_API_URL: z.string().url().default('http://100.70.137.104:8300'),
    EMBEDDING_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),

    // TRANS-0035: Speech proxy to Transcribator API SpeechModule
    TRANSCRIBATOR_API_URL: z.string().url().default('http://localhost:3700'),
    SPEECH_INTERNAL_TOKEN: z.string().min(16).optional(),
    SPEECH_PROXY_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),

    ADMIN_TOKEN: z.string().min(32).optional(),

    // CONN-0052: Image Generation providers
    // Vertex AI (Google Cloud)
    VERTEX_PROJECT_ID: z.string().optional(),
    VERTEX_LOCATION: z.string().default('us-central1'),
    VERTEX_SERVICE_ACCOUNT_JSON: z.string().optional(), // JSON key as string or file path

    // Replicate
    REPLICATE_API_TOKEN: z.string().optional(),

    // OpenAI Images (gpt-image-1)
    OPENAI_API_KEY: z.string().optional(),

    // Cloudflare R2 Storage
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().default('arcanada-mc-images'),
    R2_ENDPOINT: z.string().optional(), // https://<account_id>.r2.cloudflarestorage.com

    // Image provider feature flags
    IMAGE_PROVIDER_VERTEX_ENABLED: z.coerce.boolean().default(false),
    IMAGE_PROVIDER_REPLICATE_ENABLED: z.coerce.boolean().default(false),
    IMAGE_PROVIDER_OPENAI_ENABLED: z.coerce.boolean().default(false),
    IMAGE_PROVIDER_CODEX_ENABLED: z.coerce.boolean().default(false),

    // Image budget and rate limiting
    IMAGE_BUDGET_DAILY_USD: z.coerce.number().min(0).max(1000).default(10),
    IMAGE_RATE_LIMIT_PER_HOUR: z.coerce.number().min(1).max(500).default(50),

    // CONN-0102: STT multi-provider router (Phase 1a — Groq sync only)
    STT_MULTI_PROVIDER: envBool.default(false),
    STT_PROVIDERS_ORDER: z.string().default('groq'),
    STT_PROVIDER_GROQ_ENABLED: envBool.default(true),
    STT_GROQ_API_KEY: z.string().optional(),
    // Legacy chat/STT Groq key — referenced as fallback when STT_GROQ_API_KEY is unset.
    // Declared so the CONN-0103 conditional refine can see it in the parsed data.
    GROQ_API_KEY: z.string().optional(),
    STT_GROQ_MODEL: z.string().default('whisper-large-v3'),
    STT_GROQ_PRICE_USD_PER_MIN: z.coerce.number().min(0).max(10).default(0.00185),
    STT_GROQ_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(60_000),
    STT_GROQ_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    STT_MAX_AUDIO_BYTES: z.coerce.number().min(1024).max(26_214_400).default(26_214_400),
    STT_DAILY_BUDGET_USD: z.coerce.number().min(0).max(1000).default(10),
    STT_COST_WARN_THRESHOLD_PCT: z.coerce.number().min(0).max(1).default(0.8),

    // CONN-0103: STT Phase 1b — Deepgram + AssemblyAI + OpenAI providers + hard CB.
    // All ENABLED flags default false (fail-closed); operator flips post-Vault-provisioning.
    STT_PROVIDER_DEEPGRAM_ENABLED: envBool.default(false),
    STT_DEEPGRAM_API_KEY: z.string().optional(),
    STT_DEEPGRAM_MODEL: z.string().default('nova-3'),
    STT_DEEPGRAM_PRICE_USD_PER_MIN: z.coerce.number().min(0).max(10).default(0.0043),
    STT_DEEPGRAM_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(60_000),
    STT_DEEPGRAM_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),

    STT_PROVIDER_ASSEMBLYAI_ENABLED: envBool.default(false),
    STT_ASSEMBLYAI_API_KEY: z.string().optional(),
    STT_ASSEMBLYAI_MODEL: z.string().default('universal-2'),
    STT_ASSEMBLYAI_PRICE_USD_PER_MIN: z.coerce.number().min(0).max(10).default(0.0045),
    STT_ASSEMBLYAI_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    STT_ASSEMBLYAI_POLL_INTERVAL_MS: z.coerce.number().min(250).max(60_000).default(2_000),
    STT_ASSEMBLYAI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(5),

    STT_PROVIDER_OPENAI_ENABLED: envBool.default(false),
    STT_OPENAI_API_KEY: z.string().optional(),
    STT_OPENAI_MODEL: z.string().default('gpt-4o-mini-transcribe'),
    STT_OPENAI_PRICE_USD_PER_MIN: z.coerce.number().min(0).max(10).default(0.006),
    STT_OPENAI_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(60_000),
    STT_OPENAI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),

    // CONN-0104: STT Phase 2 — self-hosted faster-whisper-server on arcana-ai.
    // No API key (Tailscale-only listener); enablement flag gates the async
    // pipeline registration. ENABLED defaults false until Phase 2 deploys.
    STT_PROVIDER_LOCAL_WHISPER_ENABLED: envBool.default(false),
    LOCAL_WHISPER_BASE_URL: z.string().url().default('http://arcana-ai:8400'),
    STT_LOCAL_WHISPER_MODEL: z.string().default('Systran/faster-distil-whisper-large-v3'),
    STT_LOCAL_WHISPER_TIMEOUT_MS: z.coerce.number().min(1_000).max(600_000).default(300_000),
    STT_LOCAL_WHISPER_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(1),
  })
  .superRefine((data, ctx) => {
    // CONN-0103 V-AC-8 — fail-closed boot when a provider is enabled but its API key
    // slot is empty. Operator flipping STT_PROVIDER_X_ENABLED=true без provisioning
    // Vault path would otherwise crash on first request (runtime fail-open). The
    // legacy GROQ_API_KEY env counts as a valid fallback for Groq.
    const groqKey = data.STT_GROQ_API_KEY ?? data.GROQ_API_KEY;
    const providers: Array<[string, boolean, string | undefined, string]> = [
      [
        'groq',
        data.STT_PROVIDER_GROQ_ENABLED,
        groqKey,
        'STT_GROQ_API_KEY (or legacy GROQ_API_KEY)',
      ],
      [
        'deepgram',
        data.STT_PROVIDER_DEEPGRAM_ENABLED,
        data.STT_DEEPGRAM_API_KEY,
        'STT_DEEPGRAM_API_KEY',
      ],
      [
        'assemblyai',
        data.STT_PROVIDER_ASSEMBLYAI_ENABLED,
        data.STT_ASSEMBLYAI_API_KEY,
        'STT_ASSEMBLYAI_API_KEY',
      ],
      ['openai', data.STT_PROVIDER_OPENAI_ENABLED, data.STT_OPENAI_API_KEY, 'STT_OPENAI_API_KEY'],
    ];
    for (const [name, enabled, key, keyLabel] of providers) {
      if (enabled && !key) {
        ctx.addIssue({
          code: 'custom',
          message: `${keyLabel} required when STT_PROVIDER_${name.toUpperCase()}_ENABLED=true`,
          path: [keyLabel.split(' ')[0]],
        });
      }
    }
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
