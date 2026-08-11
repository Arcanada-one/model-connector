// CONN-0243 — translation-layer unit tests.

import { describe, it, expect } from 'vitest';
import { toConnectorRequest, toOpenAiChatCompletion, toOpenAiModelList } from './openai-translate';
import {
  ConnectorResponse,
  ConnectorCapabilities,
} from '../connectors/interfaces/connector.interface';
import { OpenAiChatCompletionRequest } from './dto/openai-chat.dto';

describe('toConnectorRequest', () => {
  it('maps system → systemPrompt and single user turn → prompt', () => {
    const body = {
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hello' },
      ],
    } as OpenAiChatCompletionRequest;
    const { request, requestedModel } = toConnectorRequest(body);
    expect(requestedModel).toBe('auto');
    expect(request.systemPrompt).toBe('You are terse.');
    expect(request.prompt).toBe('Hello');
  });

  it('folds multi-turn into a labelled transcript', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'bye' },
      ],
    } as OpenAiChatCompletionRequest;
    const { request } = toConnectorRequest(body);
    expect(request.prompt).toContain('User: hi');
    expect(request.prompt).toContain('Assistant: hello');
    expect(request.prompt).toContain('User: bye');
  });

  it('extracts text from array content parts', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'part-a' }] }],
    } as OpenAiChatCompletionRequest;
    const { request } = toConnectorRequest(body);
    expect(request.prompt).toBe('part-a');
  });

  it('maps response_format json_object and temperature/top_p/max_tokens to extra', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      response_format: { type: 'json_object' },
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 100,
    } as OpenAiChatCompletionRequest;
    const { request } = toConnectorRequest(body);
    expect(request.responseFormat).toEqual({ type: 'json_object' });
    expect(request.extra).toEqual({ temperature: 0.5, top_p: 0.9, max_tokens: 100 });
  });
});

describe('toOpenAiChatCompletion', () => {
  const resp: ConnectorResponse = {
    id: 'internal',
    connector: 'openmodel',
    model: 'deepseek-v4-flash',
    result: 'the answer',
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, costUsd: 0.001 },
    latencyMs: 50,
    status: 'success',
  };

  it('produces exact OpenAI shape with snake_case usage and chatcmpl id', () => {
    const out = toOpenAiChatCompletion(resp, 1_700_000_000);
    expect(out.object).toBe('chat.completion');
    expect(out.id.startsWith('chatcmpl-')).toBe(true);
    expect(out.created).toBe(1_700_000_000);
    expect(out.model).toBe('deepseek-v4-flash');
    expect(out.choices[0]).toEqual({
      index: 0,
      message: { role: 'assistant', content: 'the answer' },
      finish_reason: 'stop',
    });
    expect(out.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    // costUsd must NOT leak into the OpenAI usage object
    expect((out.usage as Record<string, unknown>).costUsd).toBeUndefined();
  });
});

describe('toOpenAiModelList', () => {
  function caps(
    name: string,
    metas: Array<{ id: string; modality?: ConnectorCapabilities['modality'] }>,
  ): ConnectorCapabilities {
    return {
      name,
      type: 'api',
      models: metas.map((m) => m.id),
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 1000,
      modelMeta: metas,
    };
  }

  it('lists only chat models, deduped, OpenAI list shape', () => {
    const out = toOpenAiModelList(
      [
        caps('openmodel', [{ id: 'deepseek-v4-flash' }]),
        caps('groq', [
          { id: 'llama-3.3-70b-versatile' },
          { id: 'whisper-large', modality: 'speech_to_text' },
        ]),
        caps('dup', [{ id: 'deepseek-v4-flash' }]),
      ],
      1_700_000_000,
    );
    expect(out.object).toBe('list');
    const ids = out.data.map((d) => d.id);
    expect(ids).toContain('deepseek-v4-flash');
    expect(ids).toContain('llama-3.3-70b-versatile');
    expect(ids).not.toContain('whisper-large'); // non-chat excluded
    expect(ids.filter((i) => i === 'deepseek-v4-flash')).toHaveLength(1); // deduped
    expect(out.data[0].object).toBe('model');
  });
});
