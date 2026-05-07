import { envSchema } from './src/config/env.schema';

describe('env.schema — image generation vars smoke', () => {
  it('parses minimal config with all image vars defaulting/optional', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data;
    // Feature flags default off
    expect(d.IMAGE_PROVIDER_VERTEX_ENABLED).toBe(false);
    expect(d.IMAGE_PROVIDER_REPLICATE_ENABLED).toBe(false);
    expect(d.IMAGE_PROVIDER_OPENAI_ENABLED).toBe(false);
    expect(d.IMAGE_PROVIDER_CODEX_ENABLED).toBe(false);
    // Budget defaults
    expect(d.IMAGE_BUDGET_DAILY_USD).toBe(10);
    expect(d.IMAGE_RATE_LIMIT_PER_HOUR).toBe(50);
    // R2 bucket default
    expect(d.R2_BUCKET).toBe('arcanada-mc-images');
    // Vertex location default
    expect(d.VERTEX_LOCATION).toBe('us-central1');
  });

  it('parses with all image vars provided', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      VERTEX_PROJECT_ID: 'arcanada-platform',
      VERTEX_LOCATION: 'us-central1',
      VERTEX_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
      REPLICATE_API_TOKEN: 'r8_testtoken',
      OPENAI_API_KEY: 'sk-test',
      R2_ACCOUNT_ID: 'abc123',
      R2_ACCESS_KEY_ID: 'key123',
      R2_SECRET_ACCESS_KEY: 'secret123',
      R2_BUCKET: 'custom-bucket',
      R2_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
      IMAGE_PROVIDER_VERTEX_ENABLED: 'true',
      IMAGE_PROVIDER_REPLICATE_ENABLED: 'true',
      IMAGE_PROVIDER_OPENAI_ENABLED: 'true',
      IMAGE_BUDGET_DAILY_USD: '25',
      IMAGE_RATE_LIMIT_PER_HOUR: '100',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const d = result.data;
    expect(d.IMAGE_PROVIDER_VERTEX_ENABLED).toBe(true);
    expect(d.IMAGE_BUDGET_DAILY_USD).toBe(25);
  });
});
