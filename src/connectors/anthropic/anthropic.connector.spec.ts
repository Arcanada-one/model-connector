import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicConnector, ANTHROPIC_LIST_PRICES_USD_PER_MTOK } from './anthropic.connector';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(__dirname, '../../../test/fixtures/connectors', name), 'utf8'),
  ) as unknown;
// Same fixture as a plain object, for tests that spread or destructure it.
const fixtureObj = (name: string) => fixture(name) as Record<string, unknown>;

class TestAnthropicConnector extends AnthropicConnector {
  body(request: Parameters<AnthropicConnector['execute']>[0]) {
    return this.buildRequestBody(request);
  }
  headers() {
    return this.getHeaders();
  }
  staticMetas() {
    return this.getStaticModelMetas();
  }
  liveMetas(json: unknown) {
    return this.extractModels(json);
  }
  url(request: Parameters<AnthropicConnector['execute']>[0]) {
    return this.buildRequestUrl(request);
  }
  parse(json: unknown, request: Parameters<AnthropicConnector['execute']>[0]) {
    return this.parseResponse(json, request);
  }
}

describe('AnthropicConnector', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'fixture-key' };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('builds a native Messages API request', () => {
    const connector = new TestAnthropicConnector();
    expect(connector.url({ prompt: 'Hello' })).toBe('https://api.anthropic.com/v1/messages');
    expect(connector.headers()).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'fixture-key',
      'anthropic-version': '2023-06-01',
    });
    expect(
      connector.body({
        prompt: 'Hello',
        systemPrompt: 'Be concise.',
        model: 'claude-sonnet-4-5',
        extra: { max_tokens: 321, temperature: 0.2, stop_sequences: ['STOP'] },
      }),
    ).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 321,
      messages: [{ role: 'user', content: 'Hello' }],
      system: 'Be concise.',
      temperature: 0.2,
      stop_sequences: ['STOP'],
    });
  });

  it('maps text and base64 image prompts to Anthropic content blocks', () => {
    const connector = new TestAnthropicConnector();
    expect(
      connector.body({
        prompt: [
          { type: 'text', text: 'Describe this.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAEC' } },
        ],
      }),
    ).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAEC' } },
          ],
        },
      ],
    });
  });

  it('rejects remote image URLs rather than adding hidden egress', () => {
    const connector = new TestAnthropicConnector();
    expect(() =>
      connector.body({
        prompt: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
      }),
    ).toThrow(/base64 data URL/);
  });

  it('parses all text blocks and token usage from an official-shape fixture', () => {
    const connector = new TestAnthropicConnector();
    expect(connector.parse(fixture('anthropic-message.json'), { prompt: 'Hello' })).toEqual({
      text: 'First paragraph.\nSecond paragraph.',
      model: 'claude-sonnet-4-5',
      inputTokens: 18,
      outputTokens: 9,
      // DEC-AUP-0028 R3 — the provider usage object is the record, kept verbatim.
      providerUsage: { input_tokens: 18, output_tokens: 9 },
      costUsd: 0,
      isError: false,
    });
  });

  it('preserves client tool calls in structured output', () => {
    const connector = new TestAnthropicConnector();
    const parsed = connector.parse(fixture('anthropic-tool-use.json'), { prompt: 'Weather?' });
    expect(parsed.text).toBe('I will check.');
    expect(parsed.structured).toEqual({
      stopReason: 'tool_use',
      toolCalls: [
        {
          id: 'toolu_01fixture',
          name: 'get_weather',
          input: { location: 'San Francisco, CA' },
        },
      ],
    });
  });

  it('fails safely when the response has neither text nor tool content', () => {
    const connector = new TestAnthropicConnector();
    expect(
      connector.parse(
        { model: 'claude-sonnet-4-5', content: [{ type: 'thinking', thinking: 'hidden' }] },
        { prompt: 'Hello' },
      ),
    ).toMatchObject({ isError: true, errorMessage: 'No supported content blocks in response' });
  });

  it('reports only capabilities implemented by the unified connector surface', () => {
    expect(new TestAnthropicConnector().getCapabilities()).toMatchObject({
      name: 'anthropic',
      type: 'api',
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: true,
      modality: 'chat',
    });
  });

  it('executes through mocked fetch without a live API call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(fixture('anthropic-message.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const response = await new AnthropicConnector().execute({ prompt: 'Hello' });
    expect(response.status).toBe('success');
    expect(response.connector).toBe('anthropic');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  // AUP-CACHE-003 / DEC-AUP-0028 R3 — the honest usage mapping.
  describe('prompt-cache usage passthrough (DEC-AUP-0028 R3)', () => {
    // Official Messages API shape (platform.claude.com prompt-caching, 2026-09-13):
    // input_tokens = uncached tail; reads and writes are ADDITIONAL to it.
    const officialUsage = {
      input_tokens: 21,
      output_tokens: 9,
      cache_read_input_tokens: 1240,
      cache_creation_input_tokens: 60,
      cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 0 },
    };

    it('maps full input = tail + writes + reads, reads to cachedInputTokens, writes separately', () => {
      const connector = new TestAnthropicConnector();
      const parsed = connector.parse(
        { ...fixtureObj('anthropic-message.json'), usage: officialUsage },
        { prompt: 'Hello' },
      );
      expect(parsed.inputTokens).toBe(21 + 60 + 1240);
      expect(parsed.outputTokens).toBe(9);
      expect(parsed.cachedInputTokens).toBe(1240);
      expect(parsed.cacheCreationInputTokens).toBe(60);
      expect(parsed.cacheCreation).toEqual({
        ephemeral5mInputTokens: 60,
        ephemeral1hInputTokens: 0,
      });
      // The subset contract the meter clamps on can never bite.
      expect(parsed.cachedInputTokens!).toBeLessThanOrEqual(parsed.inputTokens);
      expect(parsed.usageMissing).toBeUndefined();
    });

    it('copies the provider usage object verbatim, unknown keys included', () => {
      const connector = new TestAnthropicConnector();
      const usage = { ...officialUsage, server_tool_use: { web_search_requests: 1 } };
      const parsed = connector.parse(
        { ...fixtureObj('anthropic-message.json'), usage },
        { prompt: 'Hello' },
      );
      expect(parsed.providerUsage).toEqual(usage);
      expect(parsed.providerUsage).not.toBe(usage);
    });

    it('a ping-sized reply (cache fields present and 0) is reported as 0, not as absent', () => {
      const connector = new TestAnthropicConnector();
      const parsed = connector.parse(
        {
          ...fixtureObj('anthropic-message.json'),
          usage: {
            input_tokens: 8,
            output_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        { prompt: 'ping' },
      );
      expect(parsed.inputTokens).toBe(8);
      expect(parsed.cachedInputTokens).toBe(0);
      expect(parsed.cacheCreationInputTokens).toBe(0);
      expect(parsed.cacheCreation).toBeUndefined();
      expect(parsed.usageMissing).toBeUndefined();
    });

    it('a reply without cache fields leaves them undefined (provider silent ≠ 0)', () => {
      const connector = new TestAnthropicConnector();
      const parsed = connector.parse(fixture('anthropic-message.json'), { prompt: 'Hello' });
      expect(parsed.inputTokens).toBe(18);
      expect(parsed.cachedInputTokens).toBeUndefined();
      expect(parsed.cacheCreationInputTokens).toBeUndefined();
      expect(parsed.providerUsage).toEqual({ input_tokens: 18, output_tokens: 9 });
      expect(parsed.usageMissing).toBeUndefined();
    });

    it('a reply with no usage at all is the third verdict usageMissing, never zero-filled counts', () => {
      const connector = new TestAnthropicConnector();
      const { usage: _dropped, ...noUsage } = fixtureObj('anthropic-message.json');
      const parsed = connector.parse(noUsage, { prompt: 'Hello' });
      expect(parsed.usageMissing).toBe(true);
      expect(parsed.cachedInputTokens).toBeUndefined();
      expect(parsed.cacheCreationInputTokens).toBeUndefined();
      expect(parsed.providerUsage).toBeUndefined();
      expect(parsed.isError).toBe(false);
    });

    it('forwards the cache fields, the verbatim usage and usageMissing through execute()', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...fixtureObj('anthropic-message.json'), usage: officialUsage }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      const ok = await new AnthropicConnector().execute({ prompt: 'Hello' });
      expect(ok.status).toBe('success');
      expect(ok.usage.inputTokens).toBe(1321);
      expect(ok.usage.cachedInputTokens).toBe(1240);
      expect(ok.usage.cacheCreationInputTokens).toBe(60);
      expect(ok.usage.providerUsage).toEqual(officialUsage);
      expect(ok.usage.usageMissing).toBeUndefined();

      const { usage: _dropped, ...noUsage } = fixtureObj('anthropic-message.json');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(noUsage), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const missing = await new AnthropicConnector().execute({ prompt: 'Hello' });
      expect(missing.status).toBe('success');
      expect(missing.usage.usageMissing).toBe(true);
      expect(missing.usage.providerUsage).toBeUndefined();
      expect(missing.usage.cachedInputTokens).toBeUndefined();
      expect(missing.usage.cacheCreationInputTokens).toBeUndefined();
    });
  });

  // DEC-AUP-0028 R4 — the priced catalogue floor.
  describe('curated list prices (DEC-AUP-0028 R4)', () => {
    it('static metas carry the curated price for every listed model, incl. claude-fable-5-1', () => {
      const connector = new TestAnthropicConnector();
      const metas = connector.staticMetas();
      const fable = metas.find((m) => m.id === 'claude-fable-5-1');
      expect(fable?.pricing).toEqual({
        inputPerMTok: 10,
        outputPerMTok: 50,
        unit: 'USD/1M tokens',
      });
      for (const m of metas) {
        expect(m.pricing).toEqual({
          ...ANTHROPIC_LIST_PRICES_USD_PER_MTOK[m.id],
          unit: 'USD/1M tokens',
        });
      }
    });

    it('a live /models listing keeps the curated price and leaves unknown ids unpriced (never invented)', () => {
      const connector = new TestAnthropicConnector();
      const metas = connector.liveMetas({
        data: [{ id: 'claude-fable-5-1' }, { id: 'claude-experimental-9' }],
      });
      expect(metas.find((m) => m.id === 'claude-fable-5-1')?.pricing).toEqual({
        inputPerMTok: 10,
        outputPerMTok: 50,
        unit: 'USD/1M tokens',
      });
      expect(metas.find((m) => m.id === 'claude-experimental-9')?.pricing).toBeNull();
    });
  });
});
