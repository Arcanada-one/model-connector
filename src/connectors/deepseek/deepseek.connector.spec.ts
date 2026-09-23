import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEEPSEEK_LIST_PRICES_USD_PER_MTOK, DeepSeekConnector } from './deepseek.connector';

const chatFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/chat-success.json'), 'utf8'),
);
const modelsFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/models.json'), 'utf8'),
);

class TestDeepSeekConnector extends DeepSeekConnector {
  staticMetas() {
    return this.getStaticModelMetas();
  }
  liveMetas(json: unknown) {
    return this.extractModels(json);
  }
}

describe('DeepSeekConnector', () => {
  let connector: DeepSeekConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'deepseek_test_sentinel';
    delete process.env.DEEPSEEK_BASE_URL;
    connector = new DeepSeekConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
  });

  function mockJson(body: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  it('uses the exact default base, Bearer auth, and /chat/completions', async () => {
    mockJson(chatFixture);
    await connector.execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer deepseek_test_sentinel');
  });

  it('preserves a configured /v1 compatibility base', async () => {
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
    connector = new DeepSeekConnector();
    mockJson(chatFixture);
    await connector.execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('returns reasoning_content and exact cache token counts in structured output', async () => {
    mockJson(chatFixture);
    const response = await connector.execute({ prompt: 'hello', model: 'deepseek-reasoner' });
    expect(response.result).toBe('Synthetic final answer.');
    expect(response.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(response.structured).toEqual({
      reasoning_content: 'Synthetic reasoning fixture.',
      usage: { prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 5 },
    });
  });

  // A2-104 — measured on prod 2026-09-23: DeepSeek reported
  // prompt_cache_hit_tokens/prompt_cache_miss_tokens and MC returned them under
  // `structured`, but `usage.cachedInputTokens` — the field this codebase defines for
  // exactly this fact, and that orq/openrouter/anthropic all fill — was undefined. Every
  // consumer of the normalised usage therefore read "the provider said nothing about
  // caching" for a provider that had just said it. See ConnectorResponse.usage.
  it('normalises prompt_cache_hit_tokens onto usage.cachedInputTokens and keeps the provider usage verbatim', async () => {
    mockJson(chatFixture);
    const response = await connector.execute({ prompt: 'hello' });
    expect(response.usage.cachedInputTokens).toBe(7);
    expect(response.usage.providerUsage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 5,
    });
  });

  it('reports no cache write counter for DeepSeek rather than a zero that reads as a measurement', async () => {
    mockJson(chatFixture);
    const response = await connector.execute({ prompt: 'hello' });
    // DeepSeek has no cache-WRITE field: a miss token is billed at the miss rate and IS
    // the write. Emitting cacheCreationInputTokens: 0 would be indistinguishable from
    // "measured zero writes" on a provider that does report them.
    expect(response.usage.cacheCreationInputTokens).toBeUndefined();
    expect(response.usage.cacheCreation).toBeUndefined();
  });

  it('leaves cachedInputTokens undefined when DeepSeek omits the cache counters (silent is not zero)', async () => {
    mockJson({
      ...chatFixture,
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
    const response = await connector.execute({ prompt: 'hello' });
    expect(response.usage.cachedInputTokens).toBeUndefined();
    expect(response.usage.inputTokens).toBe(12);
    // reasoning_content is still passed through; what must NOT appear is an invented
    // `usage` block with zeros where DeepSeek reported nothing.
    expect(response.structured).toEqual({ reasoning_content: 'Synthetic reasoning fixture.' });
  });

  it('marks a reply with no usage block as usageMissing instead of inventing zeros', async () => {
    const { usage: _usage, ...noUsage } = chatFixture;
    mockJson(noUsage);
    const response = await connector.execute({ prompt: 'hello' });
    expect(response.usage.usageMissing).toBe(true);
    expect(response.usage.cachedInputTokens).toBeUndefined();
    expect(response.usage.providerUsage).toBeUndefined();
    expect(response.structured).toEqual({ reasoning_content: 'Synthetic reasoning fixture.' });
  });

  it('omits unsupported sampling and logprob parameters for deepseek-reasoner', async () => {
    mockJson(chatFixture);
    await connector.execute({
      prompt: 'hello',
      model: 'deepseek-reasoner',
      extra: {
        temperature: 0.2,
        top_p: 0.8,
        presence_penalty: 1,
        frequency_penalty: 1,
        logprobs: true,
        top_logprobs: 2,
        max_tokens: 100,
      },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('presence_penalty');
    expect(body).not.toHaveProperty('frequency_penalty');
    expect(body).not.toHaveProperty('logprobs');
    expect(body).not.toHaveProperty('top_logprobs');
    expect(body.max_tokens).toBe(100);
  });

  it('refreshes /models with Bearer auth and preserves /v1 compatibility', async () => {
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
    connector = new DeepSeekConnector();
    mockJson(modelsFixture);
    await connector.refreshModels();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/models');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer deepseek_test_sentinel');
    expect(connector.getCapabilities().models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it.each([
    [400, 'validation_error', 'error'],
    [401, 'auth_error', 'error'],
    [402, 'billing_error', 'error'],
    [422, 'validation_error', 'error'],
    [429, 'rate_limited', 'rate_limited'],
    [500, 'server_error', 'error'],
    [503, 'server_error', 'error'],
  ])('maps DeepSeek HTTP %i to %s without invented retry delay', async (status, type, state) => {
    mockJson({ error: { message: `synthetic ${status}` } }, status);
    const response = await connector.execute({ prompt: 'hello' });
    expect(response.status).toBe(state);
    expect(response.error).toMatchObject({ type });
    expect(response.error?.retryAfter).toBeUndefined();
  });

  it('advertises only capabilities implemented by this connector', () => {
    expect(connector.getCapabilities()).toMatchObject({
      name: 'deepseek',
      type: 'api',
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
    });
  });

  // A2-201 — costUsd was always 0 for DeepSeek because no modelMeta ever carried a
  // `pricing` entry, so the catalogue held null tariffs and `measureCostUsd` fell to
  // `'unpriced'` regardless of measured usage tokens. Fails before the price map +
  // getStaticModelMetas/extractModels overrides exist; passes after.
  describe('curated list prices (A2-201)', () => {
    it('a live /models listing attaches the curated price to the ids DeepSeek actually serves', () => {
      const test = new TestDeepSeekConnector();
      const metas = test.liveMetas({
        data: [
          { id: 'deepseek-flash' },
          { id: 'deepseek-v4-pro' },
          { id: 'deepseek-experimental' },
        ],
      });
      expect(metas.find((m) => m.id === 'deepseek-flash')?.pricing).toEqual({
        ...DEEPSEEK_LIST_PRICES_USD_PER_MTOK['deepseek-flash'],
        unit: 'USD/1M tokens',
      });
      expect(metas.find((m) => m.id === 'deepseek-v4-pro')?.pricing).toEqual({
        ...DEEPSEEK_LIST_PRICES_USD_PER_MTOK['deepseek-v4-pro'],
        unit: 'USD/1M tokens',
      });
      // Unknown ids stay unpriced (null) — never invented.
      expect(metas.find((m) => m.id === 'deepseek-experimental')?.pricing).toBeNull();
    });

    it('the static/offline floor carries pricing.null for every currently-declared static id', () => {
      // STATIC_MODELS ('deepseek-chat', 'deepseek-reasoner') predate the DeepSeek
      // rename this fix researched and are deliberately NOT in the price map (see the
      // code comment on DEEPSEEK_LIST_PRICES_USD_PER_MTOK) — this asserts that absence
      // stays an honest `null`, not a fabricated number, rather than asserting a price.
      const test = new TestDeepSeekConnector();
      const metas = test.staticMetas();
      expect(metas.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
      for (const meta of metas) {
        expect(meta.pricing).toBeNull();
      }
    });
  });
});
