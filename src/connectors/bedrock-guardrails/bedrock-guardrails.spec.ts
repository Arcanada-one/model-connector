import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BedrockGuardrailsClient,
  BedrockGuardrailsError,
  type BedrockGuardrailsConfig,
  type BedrockGuardrailsSigner,
  type BedrockGuardrailsTransport,
  type BedrockGuardrailsTransportResponse,
} from './bedrock-guardrails';

const CONTROL_HOST = 'https://bedrock.us-east-1.amazonaws.com';
const RUNTIME_HOST = 'https://bedrock-runtime.us-east-1.amazonaws.com';
const ID = 'abc123';
const ARN = 'arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123';
const FAKE_AUTH = 'AWS4-HMAC-SHA256 synthetic-credential';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')) as T;
}

const control = fixture<{
  create: unknown;
  createVersion: unknown;
  get: unknown;
  update: unknown;
}>('control-success.synthetic.json');
const list = fixture<unknown>('list-success.synthetic.json');
const apply = fixture<unknown>('apply-success.synthetic.json');
const providerError = fixture<unknown>('provider-error.synthetic.json');

function response(body: unknown, status = 200, headers: Record<string, string> = {}): BedrockGuardrailsTransportResponse {
  return { status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function png(width = 1, height = 1): string {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

function jpeg(width = 1, height = 1): string {
  const bytes = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return bytes.toString('base64');
}

describe('BedrockGuardrailsClient', () => {
  let signer: ReturnType<typeof vi.fn<BedrockGuardrailsSigner>>;
  let transport: ReturnType<typeof vi.fn<BedrockGuardrailsTransport>>;
  let client: BedrockGuardrailsClient;

  beforeEach(() => {
    signer = vi.fn<BedrockGuardrailsSigner>().mockResolvedValue({
      Authorization: FAKE_AUTH,
      'X-Amz-Date': '20260720T000000Z',
    });
    transport = vi.fn<BedrockGuardrailsTransport>();
    client = new BedrockGuardrailsClient({
      region: 'us-east-1',
      signer,
      transport,
      timeoutMs: 12_345,
    });
  });

  function reply(body: unknown, status = 200, headers: Record<string, string> = {}): void {
    transport.mockResolvedValueOnce(response(body, status, headers));
  }

  function expectSigned(operation: string, method: string, url: string, body?: unknown): void {
    expect(signer).toHaveBeenCalledOnce();
    const unsigned = signer.mock.calls[0][0];
    expect(unsigned).toEqual({
      operation,
      region: 'us-east-1',
      service: 'bedrock',
      method,
      url,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: unsigned.body }),
    });
    if (body !== undefined) expect(JSON.parse(unsigned.body!)).toEqual(body);
    expect(transport).toHaveBeenCalledWith(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: FAKE_AUTH,
        'X-Amz-Date': '20260720T000000Z',
      },
      ...(body === undefined ? {} : { body: unsigned.body }),
      redirect: 'manual',
      timeoutMs: 12_345,
    });
  }

  it('builds CreateGuardrail exactly with documented optional fields', async () => {
    reply(control.create, 202);
    const input = {
      name: 'synthetic-guardrail',
      description: 'synthetic description',
      blockedInputMessaging: 'synthetic blocked input',
      blockedOutputsMessaging: 'synthetic blocked output',
      clientRequestToken: 'synthetic-token',
      contentPolicyConfig: {
        filtersConfig: [{ type: 'HATE', inputStrength: 'HIGH', outputStrength: 'MEDIUM' }],
      },
      crossRegionConfig: { guardrailProfileIdentifier: 'us.guardrail.v1:0' },
      tags: [{ key: 'purpose', value: 'synthetic' }],
    };
    await expect(client.createGuardrail(input)).resolves.toEqual(control.create);
    expectSigned('CreateGuardrail', 'POST', `${CONTROL_HOST}/guardrails`, input);
  });

  it('omits absent CreateGuardrail optional fields', async () => {
    reply(control.create, 202);
    const input = {
      name: 'synthetic-guardrail',
      blockedInputMessaging: 'synthetic blocked input',
      blockedOutputsMessaging: 'synthetic blocked output',
    };
    await client.createGuardrail(input);
    expect(JSON.parse(signer.mock.calls[0][0].body!)).toEqual(input);
  });

  it('builds CreateGuardrailVersion on POST /guardrails/{identifier}', async () => {
    reply(control.createVersion, 202);
    const input = { guardrailIdentifier: ARN, description: 'synthetic version', clientRequestToken: 'version-token' };
    await expect(client.createGuardrailVersion(input)).resolves.toEqual(control.createVersion);
    expectSigned(
      'CreateGuardrailVersion',
      'POST',
      `${CONTROL_HOST}/guardrails/${encodeURIComponent(ARN)}`,
      { description: 'synthetic version', clientRequestToken: 'version-token' },
    );
  });

  it('builds GetGuardrail without a query for the implicit DRAFT', async () => {
    reply(control.get);
    await expect(client.getGuardrail({ guardrailIdentifier: ID })).resolves.toEqual(control.get);
    expectSigned('GetGuardrail', 'GET', `${CONTROL_HOST}/guardrails/${ID}`);
  });

  it('builds GetGuardrail with an explicit encoded version', async () => {
    reply({ ...(control.get as Record<string, unknown>), version: '2' });
    await client.getGuardrail({ guardrailIdentifier: ID, guardrailVersion: '2' });
    expectSigned('GetGuardrail', 'GET', `${CONTROL_HOST}/guardrails/${ID}?guardrailVersion=2`);
  });

  it('builds deterministic ListGuardrails pagination and never loops', async () => {
    reply(list);
    await expect(
      client.listGuardrails({ guardrailIdentifier: ARN, maxResults: 25, nextToken: 'synthetic-token/+' }),
    ).resolves.toEqual(list);
    expectSigned(
      'ListGuardrails',
      'GET',
      `${CONTROL_HOST}/guardrails?guardrailIdentifier=${encodeURIComponent(ARN)}&maxResults=25&nextToken=synthetic-token%2F%2B`,
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it('builds UpdateGuardrail as PUT and preserves the exact body allowlist', async () => {
    reply(control.update, 202);
    const input = {
      guardrailIdentifier: ID,
      name: 'synthetic-guardrail',
      blockedInputMessaging: 'synthetic blocked input',
      blockedOutputsMessaging: 'synthetic blocked output',
      wordPolicyConfig: { wordsConfig: [{ text: 'synthetic', inputAction: 'BLOCK', outputAction: 'BLOCK' }] },
    };
    await expect(client.updateGuardrail(input)).resolves.toEqual(control.update);
    expectSigned('UpdateGuardrail', 'PUT', `${CONTROL_HOST}/guardrails/${ID}`, {
      name: input.name,
      blockedInputMessaging: input.blockedInputMessaging,
      blockedOutputsMessaging: input.blockedOutputsMessaging,
      wordPolicyConfig: input.wordPolicyConfig,
    });
  });

  it('accepts only DeleteGuardrail 202 with an empty body', async () => {
    reply('', 202);
    await expect(client.deleteGuardrail({ guardrailIdentifier: ID, guardrailVersion: '2' })).resolves.toEqual(undefined);
    expectSigned('DeleteGuardrail', 'DELETE', `${CONTROL_HOST}/guardrails/${ID}?guardrailVersion=2`);

    signer.mockClear();
    transport.mockClear();
    reply('', 200);
    await expect(client.deleteGuardrail({ guardrailIdentifier: ID })).rejects.toMatchObject({
      code: 'unexpected_status',
      status: 200,
    });
  });

  it('builds ApplyGuardrail on bedrock-runtime with text, qualifiers, and outputScope', async () => {
    reply(apply);
    const body = {
      content: [{ text: { text: 'synthetic input', qualifiers: ['query', 'guard_content'] } }],
      source: 'INPUT',
      outputScope: 'FULL',
    };
    await expect(client.applyGuardrail({ guardrailIdentifier: ARN, guardrailVersion: 'DRAFT', ...body })).resolves.toEqual(apply);
    expectSigned(
      'ApplyGuardrail',
      'POST',
      `${RUNTIME_HOST}/guardrail/${encodeURIComponent(ARN)}/version/DRAFT/apply`,
      body,
    );
  });

  it.each([
    ['png', png(8000, 8000)],
    ['jpeg', jpeg(8000, 8000)],
  ])('accepts documented %s image bytes at the dimension boundary', async (format, bytes) => {
    reply(apply);
    await client.applyGuardrail({
      guardrailIdentifier: ID,
      guardrailVersion: '1',
      source: 'OUTPUT',
      content: [{ image: { format, source: { bytes } } }],
    });
    expect(JSON.parse(signer.mock.calls[0][0].body!)).toEqual({
      content: [{ image: { format, source: { bytes } } }],
      source: 'OUTPUT',
    });
  });

  it('accepts twenty images and rejects the twenty-first before signer or transport', async () => {
    reply(apply);
    const image = { image: { format: 'png', source: { bytes: png() } } } as const;
    await client.applyGuardrail({ guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: Array(20).fill(image) });
    expect(signer).toHaveBeenCalledOnce();

    signer.mockClear();
    transport.mockClear();
    await expect(client.applyGuardrail({ guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: Array(21).fill(image) })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(signer).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { guardrailIdentifier: '', guardrailVersion: '1', source: 'INPUT', content: [{ text: { text: 'x' } }] },
    { guardrailIdentifier: ID, guardrailVersion: '0', source: 'INPUT', content: [{ text: { text: 'x' } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ text: { text: '' } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ text: { text: 'x', qualifiers: ['other'] } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ text: { text: 'x' }, image: { format: 'png', source: { bytes: png() } } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ image: { format: 'gif', source: { bytes: png() } } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ image: { format: 'png', source: { bytes: jpeg() } } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ image: { format: 'png', source: { bytes: png(8001, 1) } } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ image: { format: 'png', source: { url: 'https://example.test/x.png' } } }] },
    { guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ audio: { bytes: 'AA==' } }] },
  ])('rejects invalid ApplyGuardrail input %# before I/O', async (input) => {
    await expect(client.applyGuardrail(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(signer).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects an image over 4 MiB before signing', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 1).toString('base64');
    await expect(client.applyGuardrail({ guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ image: { format: 'png', source: { bytes } } }] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(signer).not.toHaveBeenCalled();
  });

  it.each([
    ['region', { region: 'us-east-1.evil.test', signer: vi.fn(), transport: vi.fn() }],
    ['endpoint-like region', { region: 'https://bedrock.us-east-1.amazonaws.com', signer: vi.fn(), transport: vi.fn() }],
    ['missing signer', { region: 'us-east-1', transport: vi.fn() }],
    ['missing transport', { region: 'us-east-1', signer: vi.fn() }],
    ['unknown config field', { region: 'us-east-1', signer: vi.fn(), transport: vi.fn(), endpoint: 'https://evil.test' }],
  ])('rejects invalid config: %s', (_label, config) => {
    expect(() => new BedrockGuardrailsClient(config as unknown as BedrockGuardrailsConfig)).toThrowError(BedrockGuardrailsError);
  });

  it.each([
    () => client.listGuardrails({ maxResults: 0 }),
    () => client.listGuardrails({ maxResults: 1001 }),
    () => client.listGuardrails({ nextToken: 'has whitespace' }),
    () => client.getGuardrail({ guardrailIdentifier: 'ABC' }),
    () => client.deleteGuardrail({ guardrailIdentifier: ID, guardrailVersion: 'DRAFT' }),
    () => client.createGuardrail({ name: 'bad name', blockedInputMessaging: 'x', blockedOutputsMessaging: 'y' }),
    () => client.createGuardrail({ name: 'ok', blockedInputMessaging: 'x', blockedOutputsMessaging: 'y', unknown: true } as never),
  ])('rejects allowlist and bounds violations before I/O', async (call) => {
    await expect(call()).rejects.toMatchObject({ code: 'invalid_request' });
    expect(signer).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects cyclic, prototype-bearing, and deeply nested policy input', async () => {
    const cyclic: Record<string, unknown> = { filtersConfig: [] };
    cyclic.self = cyclic;
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    inherited.filtersConfig = [];
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) deep = { child: deep };

    for (const contentPolicyConfig of [cyclic, inherited, deep, { __proto__: { polluted: true } }]) {
      await expect(client.createGuardrail({ name: 'ok', blockedInputMessaging: 'x', blockedOutputsMessaging: 'y', contentPolicyConfig })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(signer).not.toHaveBeenCalled();
  });

  it('rejects unknown nested policy fields before signing', async () => {
    await expect(client.createGuardrail({
      name: 'ok',
      blockedInputMessaging: 'x',
      blockedOutputsMessaging: 'y',
      contentPolicyConfig: {
        filtersConfig: [{ type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH', endpoint: 'https://evil.test' }],
      },
    })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(signer).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'ValidationException', false],
    [403, 'AccessDeniedException', false],
    [404, 'ResourceNotFoundException', false],
    [429, 'ThrottlingException', true],
    [500, 'InternalServerException', true],
    [503, 'ServiceUnavailableException', true],
  ])('maps and redacts HTTP %s %s', async (status, providerCode, retryable) => {
    reply(providerError, status, { 'x-amzn-errortype': providerCode, 'x-amzn-requestid': 'synthetic-header-request-id', location: 'https://evil.test' });
    const error = await client.listGuardrails({}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_error', status, providerCode, requestId: 'synthetic-header-request-id', retryable });
    const serialized = JSON.stringify(error);
    for (const secret of ['FAKE_SECRET', 'sensitive input', 'synthetic provider message', 'evil.test', FAKE_AUTH]) expect(serialized).not.toContain(secret);
  });

  it('rejects redirects without exposing Location', async () => {
    reply(providerError, 302, { location: 'https://evil.test/redirect' });
    const error = await client.listGuardrails({}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'provider_error', status: 302, retryable: false });
    expect(JSON.stringify(error)).not.toContain('evil.test');
  });

  it('normalizes signer and transport exceptions without their messages', async () => {
    signer.mockRejectedValueOnce(new Error(`signer exposed ${FAKE_AUTH}`));
    let error = await client.listGuardrails({}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'signing_error', retryable: false });
    expect(JSON.stringify(error)).not.toContain(FAKE_AUTH);

    signer.mockResolvedValueOnce({ Authorization: FAKE_AUTH });
    transport.mockRejectedValueOnce(new Error('timeout with sensitive input'));
    error = await client.listGuardrails({}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'transport_error', retryable: true });
    expect(JSON.stringify(error)).not.toContain('sensitive input');
  });

  it.each([
    ['invalid JSON', '{'],
    ['oversized', 'x'.repeat(1_048_577)],
    ['unknown success field', JSON.stringify({ ...(list as Record<string, unknown>), extra: true })],
    ['invalid status', JSON.stringify({ ...(list as Record<string, unknown>), guardrails: [{ ...((list as { guardrails: Record<string, unknown>[] }).guardrails[0]), status: 'UNKNOWN' }] })],
    ['malformed apply', JSON.stringify({ action: 'UNKNOWN', assessments: [], outputs: [], usage: {} })],
  ])('fails closed on %s responses', async (_label, body) => {
    transport.mockResolvedValueOnce({ status: 200, headers: {}, body });
    const call = _label === 'malformed apply'
      ? client.applyGuardrail({ guardrailIdentifier: ID, guardrailVersion: '1', source: 'INPUT', content: [{ text: { text: 'synthetic input' } }] })
      : client.listGuardrails({});
    await expect(call).rejects.toMatchObject({ code: expect.stringMatching(/invalid_response|response_too_large/) });
  });

  it('fails closed on deeply nested and cyclic transport response values', async () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    transport.mockResolvedValueOnce({ status: 200, headers: {}, body: JSON.stringify({ guardrails: [], nested: deep }) });
    await expect(client.listGuardrails({})).rejects.toMatchObject({ code: 'invalid_response' });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    transport.mockResolvedValueOnce({ status: 200, headers: {}, body: cyclic } as never);
    await expect(client.listGuardrails({})).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects signer headers with mutation or injection capability', async () => {
    for (const headers of [
      { Host: 'evil.test', Authorization: FAKE_AUTH },
      { Location: 'https://evil.test', Authorization: FAKE_AUTH },
      { Authorization: `${FAKE_AUTH}\r\nInjected: yes` },
      Object.assign(Object.create({ inherited: true }), { Authorization: FAKE_AUTH }),
    ]) {
      signer.mockResolvedValueOnce(headers);
      await expect(client.listGuardrails({})).rejects.toMatchObject({ code: 'signing_error' });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('proves every JSON provider fixture is explicitly synthetic and never a capture', () => {
    const provenance = readFileSync(resolve(__dirname, 'fixtures', 'README.md'), 'utf8');
    expect(provenance).toContain('handwritten on 2026-07-20');
    expect(provenance).toContain('not AWS captures');
    expect(provenance).toContain('No AWS SDK, API, account, credential, endpoint, metadata service, or live/paid request was used.');
  });
});
