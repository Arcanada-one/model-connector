// AUP-CACHE-006 — AnthropicConnector with the prompt-cache policy: raw
// Messages API passthrough, the gate before the fetch, tenant from the routing
// context, byte-identical legacy responses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicConnector } from './anthropic.connector';
import { PromptCachePolicyService } from '../../prompt-cache/prompt-cache-policy.service';
import { promptCacheContext } from '../../prompt-cache/prompt-cache.context';
import { ConnectorRequest } from '../interfaces/connector.interface';
import { buildReplayRequest, loadReplayFixture } from '../../../test/prompt-cache/replay-fixture';

const fixture = loadReplayFixture();

class TestConnector extends AnthropicConnector {
  body(request: ConnectorRequest) {
    return this.buildRequestBody(request);
  }
}

function service(mode: 'off' | 'observe' | 'enforce') {
  return new PromptCachePolicyService({ mode, sink: { emit: () => undefined } });
}

/** A replay-loop step as a CONN request: Messages API fields under extra.messages_api. */
function stepRequest(step: number, promptCache?: Record<string, string>): ConnectorRequest {
  const { model, max_tokens, ...messagesApi } = buildReplayRequest(fixture, step);
  return {
    prompt: '[replay step]',
    model: model as string,
    extra: {
      max_tokens,
      messages_api: messagesApi,
      ...(promptCache ? { prompt_cache: promptCache } : {}),
    },
  };
}

const upstream = {
  id: 'msg_1',
  model: 'claude-fable-5-1',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 1 },
};

describe('AnthropicConnector + prompt-cache policy (AUP-CACHE-006)', () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'fixture-key' };
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(upstream), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('copies allow-listed Messages API fields verbatim and refuses unknown keys', () => {
    const connector = new TestConnector();
    const request = stepRequest(1);
    const body = connector.body(request) as Record<string, unknown>;
    expect(body.model).toBe(request.model);
    expect(body.max_tokens).toBe(request.extra?.max_tokens);
    expect(body.system).toEqual((request.extra?.messages_api as Record<string, unknown>).system);
    expect(body.tools).toEqual((request.extra?.messages_api as Record<string, unknown>).tools);
    expect(body.messages).toEqual(
      (request.extra?.messages_api as Record<string, unknown>).messages,
    );
    expect(() =>
      connector.body({ prompt: 'x', extra: { messages_api: { messages: [{}], stream: true } } }),
    ).toThrow(/"stream" is not a passthrough field/);
    expect(() => connector.body({ prompt: 'x', extra: { messages_api: { system: 'a' } } })).toThrow(
      /messages must be a non-empty array/,
    );
  });

  it('legacy requests are untouched: no policy field, same body as before', async () => {
    const connector = new AnthropicConnector(service('enforce'));
    const response = await connector.execute({ prompt: 'Hello', model: 'claude-fable-5-1' });
    expect(response.status).toBe('success');
    expect(response).not.toHaveProperty('promptCachePolicy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent).toEqual({
      model: 'claude-fable-5-1',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hello' }],
    });
  });

  it('enforce: a violating request is refused BEFORE any upstream call, with the decision', async () => {
    const connector = new AnthropicConnector(service('enforce'));
    const request = stepRequest(1);
    (request.extra!.messages_api as Record<string, unknown>).system = 'a string';
    const response = await promptCacheContext.run({ tenantId: 'key-A' }, () =>
      connector.execute(request),
    );
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('policy_violation');
    expect(response.error?.retryable).toBe(false);
    expect(response.error?.message).toContain('SYSTEM_NOT_BLOCKS@L1');
    const decision = response.error?.details as { action: string; tenant: string; schema: string };
    expect(decision.schema).toBe('PromptCachePolicyDecision/v1');
    expect(decision.action).toBe('refuse');
    expect(decision.tenant).toBe('key-A');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('observe: the same request is sent unchanged and the decision rides on the response', async () => {
    const connector = new TestConnector(service('observe'));
    const request = stepRequest(1);
    (request.extra!.messages_api as Record<string, unknown>).system = 'a string';
    const response = await promptCacheContext.run({ tenantId: 'key-A' }, () =>
      connector.execute(request),
    );
    expect(response.status).toBe('success');
    expect(response.promptCachePolicy?.action).toBe('mark');
    expect(response.promptCachePolicy?.verdict).toBe('VIOLATION');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent).toEqual(connector.body(request));
  });

  it('enforce: a conforming replay step passes with the oracle prefix_hash and the routed tenant', async () => {
    const connector = new AnthropicConnector(service('enforce'));
    const response = await promptCacheContext.run({ tenantId: 'key-A' }, () =>
      connector.execute(stepRequest(1, { session_id: 's-1', session_epoch: '1' })),
    );
    expect(response.status).toBe('success');
    expect(response.promptCachePolicy?.action).toBe('pass');
    expect(response.promptCachePolicy?.tenant).toBe('key-A');
    expect(response.promptCachePolicy?.session.id).toBe('s-1');
    expect(response.promptCachePolicy?.prefix_hash).toBe(
      'sha256:d4c2d0bc76c5ad0efa88dde4853233aaddf73d01b9413faf62c93f8c8de76c3c',
    );
  });

  it('without a routing context the tenant is unattributed and warned', async () => {
    const connector = new AnthropicConnector(service('enforce'));
    const response = await connector.execute(stepRequest(1));
    expect(response.promptCachePolicy?.tenant).toBe('unattributed');
    expect(response.promptCachePolicy?.findings.map((f) => f.code)).toContain(
      'TENANT_UNATTRIBUTED',
    );
  });

  it('off: no evaluation, no policy field', async () => {
    const connector = new AnthropicConnector(service('off'));
    const response = await connector.execute(stepRequest(1));
    expect(response.status).toBe('success');
    expect(response).not.toHaveProperty('promptCachePolicy');
  });

  it('malformed extra.prompt_cache / messages_api is a validation_error, not a 500 and not a send', async () => {
    const connector = new AnthropicConnector(service('enforce'));
    const bad = stepRequest(1);
    bad.extra!.prompt_cache = { session_id: 42 };
    const response = await connector.execute(bad);
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('validation_error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
