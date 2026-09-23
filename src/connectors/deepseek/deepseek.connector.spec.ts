import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEPSEEK_LIST_PRICES_USD_PER_MTOK,
  DeepSeekConnector,
  RETIRED_MODEL_ALIASES,
} from './deepseek.connector';

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

  // A2-209 — this test used to assert the OPPOSITE for `deepseek-reasoner`: that
  // temperature/top_p/presence_penalty/frequency_penalty were stripped. That rule was
  // written for a separate reasoning model that rejected them, and it was measured
  // stale against the live API on 2026-09-23 — the same four parameters on
  // `deepseek-reasoner` returned HTTP 200. Dropping a caller's sampling parameters for
  // one hard-coded (and retired) id is a silent behaviour change; forwarding them lets
  // the provider be the one that refuses.
  it('forwards sampling parameters for every model, including the retired reasoner alias', async () => {
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
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.8);
    expect(body.presence_penalty).toBe(1);
    expect(body.frequency_penalty).toBe(1);
    expect(body.max_tokens).toBe(100);
    // Still only the allow-listed keys reach the wire: `logprobs`/`top_logprobs` were
    // never forwarded by this connector and are not forwarded now.
    expect(body).not.toHaveProperty('logprobs');
    expect(body).not.toHaveProperty('top_logprobs');
  });

  it('refreshes /models with Bearer auth and preserves /v1 compatibility', async () => {
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
    connector = new DeepSeekConnector();
    mockJson(modelsFixture);
    await connector.refreshModels();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/models');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer deepseek_test_sentinel');
    expect(connector.getCapabilities().models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
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
  // A2-209 — measured against the live DeepSeek API with the operator key on
  // 2026-09-23. `GET /models` returns exactly deepseek-flash + deepseek-v4-pro, and an
  // unknown id is refused with "The supported API model names are deepseek-flash,
  // deepseek-v4-pro, but you passed ...". The three ids below are NOT in that listing
  // yet all return HTTP 200 with `"model": "deepseek-flash"` — so a request for a
  // retired id succeeded and nothing ever said it had been moved.
  describe('retired model ids (A2-209)', () => {
    it('defaults to a model the provider actually serves, not a retired alias', async () => {
      mockJson(chatFixture);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('deepseek-flash');
      expect(Object.keys(RETIRED_MODEL_ALIASES)).not.toContain(body.model);
    });

    it('advertises only the served ids', () => {
      expect(connector.getCapabilities().models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    });

    it.each(Object.keys(RETIRED_MODEL_ALIASES))(
      'passes the retired id %s through verbatim rather than rewriting it locally',
      async (retired) => {
        mockJson(chatFixture);
        await connector.execute({ prompt: 'hello', model: retired });
        // The aliases are not equivalent to one another — deepseek-chat is the only
        // route to NON-reasoning flash, measured — so resolving them here would
        // silently change what the caller gets. The provider owns that resolution.
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe(retired);
      },
    );

    it.each(Object.keys(RETIRED_MODEL_ALIASES))(
      'surfaces the substitution when the provider serves %s under another id',
      async (retired) => {
        mockJson(chatFixture);
        const response = await connector.execute({ prompt: 'hello', model: retired });
        // Not an error: the request succeeded, and the caller keeps its answer.
        expect(response.status).toBe('success');
        expect(response.result).toBe('Synthetic final answer.');
        // ...but the move is now visible, with BOTH ids legible.
        expect(response.modelSubstituted).toEqual({
          requested: retired,
          served: 'deepseek-flash',
        });
        // `model` keeps meaning "what served it" — unchanged for existing readers.
        expect(response.model).toBe('deepseek-flash');
      },
    );

    it('claims no substitution when the served id is the requested one', async () => {
      mockJson(chatFixture);
      const response = await connector.execute({ prompt: 'hello', model: 'deepseek-flash' });
      expect(response.modelSubstituted).toBeUndefined();
    });

    it('claims no substitution when the caller named no model', async () => {
      mockJson(chatFixture);
      const response = await connector.execute({ prompt: 'hello' });
      // The connector's own DEFAULT_MODEL is not a caller's request, so there is
      // nothing for a substitution to be measured against.
      expect(response.modelSubstituted).toBeUndefined();
    });

    it('claims no substitution when the provider echoes no model at all', async () => {
      const { model: _model, ...noModel } = chatFixture;
      mockJson(noModel);
      const response = await connector.execute({ prompt: 'hello', model: 'deepseek-reasoner' });
      // Silence is the third verdict: absent, not a guessed `{requested, served}`.
      expect(response.modelSubstituted).toBeUndefined();
    });

    it('treats a case-only difference as no substitution', async () => {
      mockJson({ ...chatFixture, model: 'DeepSeek-Flash' });
      const response = await connector.execute({ prompt: 'hello', model: 'deepseek-flash' });
      expect(response.modelSubstituted).toBeUndefined();
    });
  });

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

    // A2-209 — this test used to assert that the offline floor was made of two ids the
    // provider does not serve and that BOTH were unpriced. That was an accurate record
    // of a broken state: the CI/offline floor advertised `deepseek-chat` and
    // `deepseek-reasoner` (retired 2026-07-24) and omitted `deepseek-v4-pro`, the one
    // priced model reachable without a live refresh. Now the floor is the served list,
    // so every static id carries a price.
    it('the static/offline floor is the served ids, each carrying its curated price', () => {
      const test = new TestDeepSeekConnector();
      const metas = test.staticMetas();
      expect(metas.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
      for (const meta of metas) {
        expect(meta.pricing).toEqual({
          ...DEEPSEEK_LIST_PRICES_USD_PER_MTOK[meta.id],
          unit: 'USD/1M tokens',
        });
      }
      // No retired id survives in the advertised floor.
      for (const retired of Object.keys(RETIRED_MODEL_ALIASES)) {
        expect(metas.map((m) => m.id)).not.toContain(retired);
      }
    });
  });
});
