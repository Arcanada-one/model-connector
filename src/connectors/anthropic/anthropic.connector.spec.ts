import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicConnector } from './anthropic.connector';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(__dirname, '../../../test/fixtures/connectors', name), 'utf8'),
  ) as unknown;

class TestAnthropicConnector extends AnthropicConnector {
  body(request: Parameters<AnthropicConnector['execute']>[0]) {
    return this.buildRequestBody(request);
  }
  headers() {
    return this.getHeaders();
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
});
