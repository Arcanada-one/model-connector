// CONN-0243 — OpenAiCompatController unit tests (mock failover router + connectors service).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { OpenAiCompatController } from './openai-compat.controller';
import { FailoverExhaustedError, FailoverAbortError } from '../connectors/failover/failover.errors';
import {
  ConnectorResponse,
  ConnectorCapabilities,
} from '../connectors/interfaces/connector.interface';
import { OpenAiChatCompletionRequest } from './dto/openai-chat.dto';

function success(): ConnectorResponse {
  return {
    id: 'r',
    connector: 'groq',
    model: 'llama-3.3-70b-versatile',
    result: 'hi there',
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0 },
    latencyMs: 9,
    status: 'success',
  };
}

function makeController(opts: {
  complete?: () => Promise<ConnectorResponse>;
  caps?: ConnectorCapabilities[];
}) {
  const failover = { complete: vi.fn(opts.complete ?? (() => Promise.resolve(success()))) };
  const connectors = {
    listCapabilities: vi.fn(() => opts.caps ?? []),
    // CONN-1665 — listModels routes through the policy-filtered view; these
    // tests exercise legacy (policy-less) keys, so it returns the full list.
    listCapabilitiesForKey: vi.fn(async () => opts.caps ?? []),
  };
  const controller = new OpenAiCompatController(
    failover as unknown as ConstructorParameters<typeof OpenAiCompatController>[0],
    connectors as unknown as ConstructorParameters<typeof OpenAiCompatController>[1],
  );
  return { controller, failover, connectors };
}

const req = { apiKey: { id: 'key-1' } } as never;

function body(extra: Partial<OpenAiChatCompletionRequest> = {}): OpenAiChatCompletionRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: 'hello' }],
    ...extra,
  } as OpenAiChatCompletionRequest;
}

describe('OpenAiCompatController.chatCompletions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC1: valid body → 200 OpenAI chat.completion shape', async () => {
    const { controller, failover } = makeController({});
    const out = await controller.chatCompletions(body(), undefined, req);
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0].message.content).toBe('hi there');
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(failover.complete).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'hello' }),
      'key-1',
      { requestedModel: 'auto' },
    );
  });

  it('stream:true → 400 unsupported', async () => {
    const { controller } = makeController({});
    await expect(
      controller.chatCompletions(body({ stream: true }), undefined, req),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('tools present → 400 unsupported', async () => {
    const { controller } = makeController({});
    await expect(
      controller.chatCompletions(body({ tools: [{}] }), undefined, req),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('FailoverExhaustedError → 503 cascade_exhausted', async () => {
    const { controller } = makeController({
      complete: () => Promise.reject(new FailoverExhaustedError([])),
    });
    await expect(controller.chatCompletions(body(), undefined, req)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('abort-class FailoverAbortError (validation_error) → 400, not 503 (D1)', async () => {
    const { controller } = makeController({
      complete: () =>
        Promise.reject(new FailoverAbortError('openmodel', 'm', 'validation_error', 'bad input')),
    });
    await expect(controller.chatCompletions(body(), undefined, req)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('abort-class auth_error → 503 (mapped via HTTP_ERROR_STATUS)', async () => {
    const { controller } = makeController({
      complete: () => Promise.reject(new FailoverAbortError('groq', 'm', 'auth_error', 'no key')),
    });
    await expect(controller.chatCompletions(body(), undefined, req)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('upstream rate_limited response → 429', async () => {
    const limited: ConnectorResponse = {
      ...success(),
      status: 'error',
      error: { type: 'rate_limited', message: '429', retryable: true, recommendation: 'wait' },
    };
    const { controller } = makeController({ complete: () => Promise.resolve(limited) });
    await expect(controller.chatCompletions(body(), undefined, req)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });
});

describe('OpenAiCompatController.listModels', () => {
  it('AC4: GET /v1/models → OpenAI list shape, chat only', async () => {
    const caps: ConnectorCapabilities[] = [
      {
        name: 'openmodel',
        type: 'api',
        models: ['deepseek-v4-flash'],
        supportsStreaming: false,
        supportsJsonSchema: true,
        supportsTools: false,
        maxTimeout: 1000,
        modelMeta: [{ id: 'deepseek-v4-flash', modality: 'chat' }],
      },
    ];
    const { controller } = makeController({ caps });
    const out = await controller.listModels(req);
    expect(out.object).toBe('list');
    expect(out.data[0]).toMatchObject({
      id: 'deepseek-v4-flash',
      object: 'model',
      owned_by: 'openmodel',
    });
  });
});
