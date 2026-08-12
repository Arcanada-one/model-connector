import { z } from 'zod';
import { GROQ_FREE_MODELS_DEFAULT_CSV } from '../connectors/groq/groq.catalogue';

// CONN-0102: z.coerce.boolean() coerces ANY non-empty string to `true`
// (including the literal "false"). For env flags where operators set
// `FOO=false` and expect false, we need explicit parsing.
export function parseEnvBool(v: boolean | string | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  const lower = v.trim().toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === '') return false;
  return true;
}

const envBool = z.union([z.boolean(), z.string()]).transform(parseEnvBool);

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

    // ARCA-0011 multi-modal prompt support (ContentBlock[] forwarding).
    // Informational kill-switch reserved for incident response; per-connector
    // runtime guard already short-circuits non-openrouter connectors.
    MC_MULTI_MODAL_ENABLED: envBool.default(true),

    // CONN-0089 output-guard middleware
    OUTPUT_GUARD_ENABLED: z.coerce.boolean().default(true),
    OUTPUT_GUARD_MAX_RETRIES: z.coerce.number().min(0).max(5).default(3),
    OUTPUT_GUARD_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),

    CLAUDE_CODE_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    CURSOR_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(1),
    GEMINI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    // CONN-0242: native Gemini Developer API, distinct from the Gemini CLI above.
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_API_BASE_URL: z
      .string()
      .url()
      .default('https://generativelanguage.googleapis.com/v1beta'),
    GEMINI_API_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    GEMINI_API_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    CODEX_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    // CONN-0223: declared here so the paid-tier boot guard (superRefine below) can
    // inspect it. The OpenRouter connector also reads it directly from process.env
    // (pre-schema path) — this declaration brings it into the validated schema.
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    GROQ_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    GROK_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
    AZURE_OPENAI_DEPLOYMENT: z.string().min(1).optional(),
    AZURE_OPENAI_API_VERSION: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .default('2024-10-21'),
    AZURE_OPENAI_API_KEY: z.string().optional(),
    AZURE_OPENAI_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    AZURE_OPENAI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    FIREWORKS_API_KEY: z.string().optional(),
    FIREWORKS_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    FIREWORKS_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    CEREBRAS_API_KEY: z.string().optional(),
    CEREBRAS_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    CEREBRAS_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    PERPLEXITY_API_KEY: z.string().optional(),
    PERPLEXITY_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    PERPLEXITY_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    // CONN-0239: orq.ai OpenAI-compatible gateway connector.
    // Vault: secret/connector/orq_api_key. Key read directly from process.env in connector.
    ORQ_API_KEY: z.string().optional(),
    ORQ_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    ORQ_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    // CONN-0255 — native OpenAI Responses API connector. OPENAI_API_KEY is
    // declared with the image-provider settings below and shared intentionally.
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com'),
    OPENAI_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    OPENAI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    MISTRAL_API_KEY: z.string().optional(),
    MISTRAL_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    MISTRAL_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    COHERE_API_KEY: z.string().optional(),
    COHERE_BASE_URL: z.string().url().default('https://api.cohere.com'),
    COHERE_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    COHERE_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    TOGETHER_API_KEY: z.string().optional(),
    TOGETHER_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    TOGETHER_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    // CONN-0252: native Cloudflare Workers AI account-scoped REST API.
    CLOUDFLARE_WORKERS_AI_ACCOUNT_ID: z.string().optional(),
    CLOUDFLARE_WORKERS_AI_API_TOKEN: z.string().optional(),
    CLOUDFLARE_WORKERS_AI_BASE_URL: z
      .string()
      .url()
      .default('https://api.cloudflare.com/client/v4'),
    CLOUDFLARE_WORKERS_AI_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    CLOUDFLARE_WORKERS_AI_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    HF_TOKEN: z.string().optional(),
    HUGGINGFACE_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    HUGGINGFACE_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10),
    OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
    OLLAMA_DEFAULT_MODEL: z.string().min(1).default('llama3.2'),
    OLLAMA_TIMEOUT_MS: z.coerce.number().min(1_000).max(600_000).default(300_000),
    OLLAMA_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(2),
    EMBEDDING_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(8),

    // CONN-0244: non-secret Bedrock routing configuration. Identity is supplied
    // through the connector's injected signer and is intentionally absent here.
    BEDROCK_REGION: z
      .string()
      .regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, 'must be an AWS region identifier')
      .default('us-east-1'),
    BEDROCK_MODELS: z
      .string()
      .default('amazon.nova-lite-v1:0,anthropic.claude-3-5-sonnet-20241022-v2:0')
      .transform((value, ctx) => {
        const models = [
          ...new Set(
            value
              .split(',')
              .map((model) => model.trim())
              .filter(Boolean),
          ),
        ];
        if (models.length === 0) {
          ctx.addIssue({ code: 'custom', message: 'must contain at least one model ID' });
          return z.NEVER;
        }
        return models;
      }),

    CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().min(1).max(50).default(5),
    CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().min(1_000).max(300_000).default(30_000),

    EMBEDDING_API_URL: z.string().url().default('http://100.70.137.104:8300'),
    EMBEDDING_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),

    // TRANS-0035: Speech proxy to Transcribator API SpeechModule
    TRANSCRIBATOR_API_URL: z.string().url().default('http://localhost:3700'),
    SPEECH_INTERNAL_TOKEN: z.string().min(16).optional(),
    SPEECH_PROXY_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),
    TTS_PROVIDER_DEEPGRAM_ENABLED: envBool.default(false),
    TTS_DEEPGRAM_API_KEY: z.string().min(1).optional(),
    TTS_DEEPGRAM_BASE_URL: z
      .string()
      .url()
      .refine(
        (value) => {
          const url = new URL(value);
          return (
            url.protocol === 'https:' &&
            url.hostname === 'api.deepgram.com' &&
            url.port === '' &&
            (url.pathname === '/' || url.pathname === '')
          );
        },
        {
          message: 'TTS_DEEPGRAM_BASE_URL must be the official HTTPS API origin',
        },
      )
      .default('https://api.deepgram.com'),
    TTS_DEEPGRAM_TIMEOUT_MS: z.coerce.number().min(1_000).max(120_000).default(30_000),

    // CONN-0311: native Together Orpheus TTS. Default-off until key provisioning.
    TTS_PROVIDER_TOGETHER_ENABLED: envBool.default(false),
    TOGETHER_BASE_URL: z.string().url().default('https://api.together.ai/v1'),
    TTS_TOGETHER_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(60_000),

    ADMIN_TOKEN: z.string().min(32).optional(),
    WATCHER_REPAIR_TOKEN: z.string().min(32).optional(),

    // CTRL-0026 Phase 2: purpose-scoped read token for GET /stats/requests/daily
    // (StatsReadGuard). Never accepts ADMIN_TOKEN or an inference ApiKey.
    STATS_READ_TOKEN: z.string().min(32).optional(),

    // CONN-0052: Image Generation providers
    // Vertex AI (Google Cloud)
    VERTEX_PROJECT_ID: z.string().optional(),
    VERTEX_LOCATION: z.string().default('us-central1'),
    VERTEX_SERVICE_ACCOUNT_JSON: z.string().optional(), // JSON key as string or file path

    // CONN-0256: native unary Vertex generative connector. Authentication is
    // injected at runtime; these values contain no credentials.
    VERTEX_GENERATIVE_PROJECT: z.string().min(1).default('unconfigured-project'),
    VERTEX_GENERATIVE_LOCATION: z.string().min(1).default('us-central1'),
    VERTEX_GENERATIVE_MODELS: z.string().min(1).default('gemini-2.5-flash'),

    // Replicate
    REPLICATE_API_TOKEN: z.string().optional(),

    // OpenAI Images (gpt-image-1)
    OPENAI_API_KEY: z.string().optional(),
    ELEVENLABS_API_KEY: z.string().min(1).optional(),

    // CONN-0213: Fal.ai (image generation; video/audio backlog CONN-0215/CONN-0216)
    // Vault: arcanada/prod/env/model-connector-fal-ai · field `api_key`
    // Source URL: https://fal.ai/dashboard/keys
    FAL_AI_API_KEY: z.string().optional(),

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
    IMAGE_PROVIDER_FAL_AI_ENABLED: z.coerce.boolean().default(false),

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

    // CONN-0104: STT Phase 2 — self-hosted faster-whisper-server on arcana-prod.
    // No API key (Tailscale-only listener); enablement flag gates the async
    // pipeline registration. ENABLED defaults false until Phase 2 deploys.
    STT_PROVIDER_LOCAL_WHISPER_ENABLED: envBool.default(false),
    LOCAL_WHISPER_BASE_URL: z.string().url().default('http://arcana-prod:8400'),
    STT_LOCAL_WHISPER_MODEL: z.string().default('Systran/faster-distil-whisper-large-v3'),
    STT_LOCAL_WHISPER_TIMEOUT_MS: z.coerce.number().min(1_000).max(600_000).default(300_000),
    STT_LOCAL_WHISPER_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(1),
    // CONN-0223: OpenModel free-tier cascade
    OPENMODEL_ENABLED: envBool.default(false),
    OPENMODEL_API_KEY: z.string().optional(),
    OPENMODEL_BASE_URL: z.string().url().default('https://api.openmodel.ai/v1'),
    OPENMODEL_FREE_MODELS: z.string().default('deepseek-v4-flash'),
    // CONN-1672 — operator-curated groq free-tier chat allowlist (CSV). Groq's
    // free tier is genuinely $0 (rate-limited); the groq connector suppresses the
    // provider's list-price for these ids so they tier as catalog-free instead of
    // being overridden to paid by deriveTier. Default sourced from
    // GROQ_FREE_MODELS_DEFAULT_CSV (single source of truth — no drift).
    GROQ_FREE_MODELS: z.string().default(GROQ_FREE_MODELS_DEFAULT_CSV),
    OPENMODEL_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(30_000),
    OPENMODEL_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(2),
    ANTHROPIC_ENABLED: envBool.default(false),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com/v1'),
    ANTHROPIC_TIMEOUT_MS: z.coerce.number().min(1_000).max(300_000).default(120_000),
    ANTHROPIC_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(4),
    // CONN-0237 Part 1 — three INDEPENDENT free-pool providers (openmodel / groq /
    // openrouter) before the paid rung, so a single provider's rate-limit (e.g. the
    // shared OpenRouter 429 pool) no longer fails the whole free fallback. groq rung
    // requires GROQ_API_KEY (present on prod). Verified live 2026-06-23:
    // groq:llama-3.3-70b-versatile → 201 success in ~1s.
    // CONN-0244 — DEEPENED free fallback. openmodel:deepseek-v4-flash was REMOVED (paid gateway;
    // tagging it `:free` burned the operator's balance). The old 3-rung chain effectively rode on
    // ONE live rung (groq) — a single groq rate-limit meant cascade_exhausted. Every rung below
    // was LIVE-PROBED on prod (status=success, costUsd=0). Providers are INTERLEAVED (groq fast-
    // first; openrouter reserves at positions 3 & 6) so a whole-provider outage still has a
    // cross-provider fallback before exhaustion. gemini was probed and EXCLUDED — its CLI returns
    // execution_error on prod (dead, not added).
    // FORMAT (cascade.profiles parseCascadeOrder): tier = text after the LAST colon, so a model id
    // may NOT contain a colon — openrouter `:free`-suffixed ids are unrepresentable here; only
    // colon-free free ids are used (maverick, openrouter/free). paid rungs are filtered out when
    // CASCADE_PAID_ENABLED=false and must stay last (validateFreeBeforePaid).
    CASCADE_LOW_REASONING_ORDER: z
      .string()
      .default(
        'groq:llama-3.3-70b-versatile:free,' +
          'groq:llama-3.1-8b-instant:free,' +
          'openrouter:meta-llama/llama-4-maverick:free,' +
          'groq:meta-llama/llama-4-scout-17b-16e-instruct:free,' +
          'groq:openai/gpt-oss-120b:free,' +
          'openrouter:openrouter/free:free,' +
          'groq:qwen/qwen3-32b:free,' +
          'openrouter:deepseek-v4-flash:paid',
      ),
    CASCADE_PAID_ENABLED: envBool.default(false),
    CASCADE_PAID_DAILY_BUDGET_USD: z.coerce.number().min(0).max(100).default(0.17),
    CASCADE_PAID_MODEL: z.string().default('deepseek-v4-flash'),

    // CONN-0244 — per-provider access. CSV `name:level` (level = use | read | none):
    //   use  = fully enabled (default for any provider not listed),
    //   read = visible in catalog but NOT routable (no cascade / no /execute),
    //   none = hidden entirely.
    // Default marks OpenModel READ-only: it is a paid gateway the operator cannot fund, so it
    // stays visible in the catalog (paid, marked read-only) but MC never routes traffic to it.
    PROVIDER_ACCESS: z.string().default('openmodel:read'),

    // CONN-0245 — DB-as-source-of-truth model catalog: cron cadence + Redis
    // cache over the DB read path. Cache is an accelerator only; the DB is
    // the source of truth (getCatalog() never calls a provider directly).
    CATALOG_FULL_REFRESH_CRON: z.string().default('*/15 * * * *'),
    CATALOG_STATUS_REFRESH_MS: z.coerce.number().min(1_000).default(300_000),
    CATALOG_CACHE_TTL_MS: z.coerce.number().min(0).default(30_000),
    CATALOG_CACHE_ENABLED: envBool.default(true),
    // CONN-0243 — OpenAI-compatible failover gateway (POST /v1/chat/completions).
    // Free-first provider priority for the failover chain (highest first). DeepSeek
    // (openmodel) is the operator-mandated first free hop and is promoted ahead of the
    // rest within the free tier regardless of this order.
    FAILOVER_PROVIDER_ORDER: z.string().default('openmodel,groq,openrouter,gemini'),
    // The model id that represents DeepSeek's default free hop.
    FAILOVER_DEEPSEEK_MODEL: z.string().default('deepseek-v4-flash'),
    // Append paid candidates after all free ones. Default OFF (free-only gateway).
    FAILOVER_PAID_ENABLED: envBool.default(false),
    // When true (default), a client-requested model that fails (or is unknown) falls
    // back to the free-first chain — the Hermes use case. Set false for strict callers
    // that must not silently downgrade a requested paid model to a free one.
    FAILOVER_ALLOW_FREE_DOWNGRADE: envBool.default(true),
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
    if (data.TTS_PROVIDER_DEEPGRAM_ENABLED && !data.TTS_DEEPGRAM_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        message: 'TTS_DEEPGRAM_API_KEY required when TTS_PROVIDER_DEEPGRAM_ENABLED=true',
        path: ['TTS_DEEPGRAM_API_KEY'],
      });
    }
    // CONN-0223 — OpenModel boot-guard
    if (data.OPENMODEL_ENABLED && !data.OPENMODEL_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        message: 'OPENMODEL_API_KEY required when OPENMODEL_ENABLED=true',
        path: ['OPENMODEL_API_KEY'],
      });
    }
    if (data.ANTHROPIC_ENABLED && !data.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ANTHROPIC_API_KEY required when ANTHROPIC_ENABLED=true',
        path: ['ANTHROPIC_API_KEY'],
      });
    }
    // CONN-0223 — Cascade paid-tier boot-guard (V-AC-10 "paid tier likewise").
    // The default paid-tier connector is openrouter; enabling the paid tier without
    // a key would silently fail on the first paid call.
    if (data.CASCADE_PAID_ENABLED && !data.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        message: 'OPENROUTER_API_KEY required when CASCADE_PAID_ENABLED=true',
        path: ['OPENROUTER_API_KEY'],
      });
    }
    if (data.TTS_PROVIDER_TOGETHER_ENABLED && !data.TOGETHER_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        message: 'TOGETHER_API_KEY required when TTS_PROVIDER_TOGETHER_ENABLED=true',
        path: ['TOGETHER_API_KEY'],
      });
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
