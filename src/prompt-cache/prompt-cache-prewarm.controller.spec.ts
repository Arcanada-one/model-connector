// AUP-CACHE-006 — pre-warm endpoint: max_tokens 0 through the same choke point.

import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  PrewarmRequestSchema,
  PromptCachePrewarmController,
} from './prompt-cache-prewarm.controller';
import { ConnectorsService } from '../connectors/connectors.service';
import { ConnectorResponse } from '../connectors/interfaces/connector.interface';

const okResponse: ConnectorResponse = {
  id: 'r1',
  connector: 'anthropic',
  model: 'claude-fable-5-1',
  result: '',
  usage: { inputTokens: 1400, outputTokens: 0, totalTokens: 1400, costUsd: 0 },
  latencyMs: 5,
  status: 'success',
};

function build(response: ConnectorResponse) {
  const execute = vi.fn().mockResolvedValue(response);
  const controller = new PromptCachePrewarmController({ execute } as unknown as ConnectorsService);
  return { execute, controller };
}

const body = PrewarmRequestSchema.parse({
  model: 'claude-fable-5-1',
  messages_api: {
    system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'y', cache_control: { type: 'ephemeral' } }],
      },
    ],
  },
  prompt_cache: { session_id: 's', session_epoch: '1' },
});

describe('PromptCachePrewarmController (AUP-CACHE-006)', () => {
  it('dispatches through ConnectorsService.execute with max_tokens 0 and the raw fields', async () => {
    const { execute, controller } = build(okResponse);
    const result = await controller.prewarm(body, { apiKey: { id: 'key-A' } } as never);
    expect(execute).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({
        model: 'claude-fable-5-1',
        maxRetries: 0,
        extra: expect.objectContaining({
          max_tokens: 0,
          messages_api: body.messages_api,
          prompt_cache: { session_id: 's', session_epoch: '1' },
        }),
      }),
      'key-A',
    );
    expect(result.prewarm).toBe(true);
    expect(result.usage.inputTokens).toBe(1400);
  });

  it('maps a policy refusal to 403 with the decision', async () => {
    const { controller } = build({
      ...okResponse,
      status: 'error',
      error: {
        type: 'policy_violation',
        message: 'refused',
        retryable: false,
        recommendation: 'abort',
      },
    });
    await expect(controller.prewarm(body, { apiKey: { id: 'key-A' } } as never)).rejects.toSatisfy(
      (err: unknown) => err instanceof HttpException && err.getStatus() === 403,
    );
  });

  it('refuses unknown fields and connectors at the schema', () => {
    expect(PrewarmRequestSchema.safeParse({ ...body, connector: 'openrouter' }).success).toBe(
      false,
    );
    expect(
      PrewarmRequestSchema.safeParse({
        ...body,
        messages_api: { ...body.messages_api, stream: true },
      }).success,
    ).toBe(false);
  });
});
