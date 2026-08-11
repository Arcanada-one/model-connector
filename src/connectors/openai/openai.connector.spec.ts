import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SYNTHETIC_API_KEY = 'synthetic-openai-key-CONN-0288';
const PRODUCTION_PATH = resolve(__dirname, 'openai.connector.ts');
const MODULE_SPECIFIER = './openai.connector';
const FIXTURE_ROOT = resolve(__dirname, '../../..', 'test/fixtures/connectors');

const CATEGORY_KEYS = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
] as const;

type Category = (typeof CATEGORY_KEYS)[number];
type ModerationInput =
  | string
  | string[]
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

interface ModerateRequest {
  input: ModerationInput;
  model?: string;
  timeout?: number;
}

interface OperationError {
  type: string;
  message: string;
  retryable: boolean;
}

interface NormalizedResult {
  flagged: boolean;
  categories: Record<Category, boolean>;
  categoryScores: Record<Category, number>;
  categoryAppliedInputTypes: Record<Category, Array<'text' | 'image'>>;
}

interface ModerateResult {
  status: 'success' | 'error' | 'timeout' | 'rate_limited';
  id?: string;
  model: string;
  results: NormalizedResult[];
  error?: OperationError;
}

interface ConnectorResponse {
  status: string;
  result: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  error?: { message: string };
}

interface OpenAiConnectorInstance {
  execute(request: Record<string, unknown>): Promise<ConnectorResponse>;
  moderate(request: ModerateRequest): Promise<ModerateResult>;
  refreshModels(): Promise<void>;
  getCapabilities(): Record<string, unknown>;
}

interface OpenAiModuleShape {
  OpenAiConnector: new () => OpenAiConnectorInstance;
}

interface FixtureEnvelope extends Record<string, unknown> {
  _fixture_provenance: string;
}

const loadModule = async (): Promise<OpenAiModuleShape> =>
  (await import(/* @vite-ignore */ MODULE_SPECIFIER)) as OpenAiModuleShape;

const loadFixture = (name: string): FixtureEnvelope =>
  JSON.parse(readFileSync(resolve(FIXTURE_ROOT, name), 'utf8')) as FixtureEnvelope;

const providerBody = (name: string): Record<string, unknown> => {
  const fixture = structuredClone(loadFixture(name));
  delete fixture._fixture_provenance;
  return fixture;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const RESPONSES_FIXTURE_PROVENANCE =
  'Handwritten deterministic synthetic fixture for immutable Responses preservation; no provider call or capture.';
const RESPONSES_FIXTURE = {
  _fixture_provenance: RESPONSES_FIXTURE_PROVENANCE,
  id: 'resp_synthetic_001',
  status: 'completed',
  model: 'gpt-4.1-mini',
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'Hello!', annotations: [] }],
    },
  ],
  usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
};

const MODELS_FIXTURE_PROVENANCE =
  'Handwritten deterministic synthetic fixture for immutable model refresh; no provider call or capture.';
const MODELS_FIXTURE = {
  _fixture_provenance: MODELS_FIXTURE_PROVENANCE,
  object: 'list',
  data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }],
};

describe('OpenAiConnector Moderations extension', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = SYNTHETIC_API_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  it('has the production module required by the RED contract', () => {
    expect(existsSync(PRODUCTION_PATH), 'production is intentionally absent in RED').toBe(true);
  });

  describe('immutable completed Responses behavior', () => {
    it('preserves endpoint, auth, request mapping, output, usage, and capabilities', async () => {
      expect(RESPONSES_FIXTURE_PROVENANCE).toContain('no provider call or capture');
      const { OpenAiConnector } = await loadModule();
      const connector = new OpenAiConnector();
      const responseBody = structuredClone(RESPONSES_FIXTURE);
      delete (responseBody as { _fixture_provenance?: string })._fixture_provenance;
      fetchMock.mockResolvedValueOnce(jsonResponse(responseBody));

      const response = await connector.execute({
        prompt: 'Hello',
        systemPrompt: 'Be concise',
        model: 'gpt-4.1',
        effort: 'high',
        extra: { max_output_tokens: 256, temperature: 0.2 },
      });

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYNTHETIC_API_KEY}`,
        },
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
        model: 'gpt-4.1',
        input: 'Hello',
        instructions: 'Be concise',
        reasoning: { effort: 'high' },
        max_output_tokens: 256,
        temperature: 0.2,
      });
      expect(response).toMatchObject({
        status: 'success',
        result: 'Hello!',
        model: 'gpt-4.1-mini',
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, costUsd: 0 },
      });
      expect(connector.getCapabilities()).toMatchObject({
        name: 'openai',
        type: 'api',
        modality: 'chat',
        supportsStreaming: false,
        supportsJsonSchema: true,
        supportsTools: false,
      });
    });

    it('preserves structured output, incomplete response, and model refresh behavior', async () => {
      expect(MODELS_FIXTURE_PROVENANCE).toContain('no provider call or capture');
      const { OpenAiConnector } = await loadModule();
      const connector = new OpenAiConnector();
      const incomplete = structuredClone(RESPONSES_FIXTURE);
      delete (incomplete as { _fixture_provenance?: string })._fixture_provenance;
      incomplete.status = 'incomplete';
      Object.assign(incomplete, { incomplete_details: { reason: 'max_output_tokens' } });
      fetchMock.mockResolvedValueOnce(jsonResponse(incomplete));
      const schema = { type: 'object', properties: { answer: { type: 'string' } } };
      const response = await connector.execute({ prompt: 'Answer', jsonSchema: schema });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).text).toEqual({
        format: { type: 'json_schema', name: 'response', strict: true, schema },
      });
      expect(response.status).toBe('error');
      expect(response.error?.message).toContain('max_output_tokens');

      const models = structuredClone(MODELS_FIXTURE);
      delete (models as { _fixture_provenance?: string })._fixture_provenance;
      fetchMock.mockResolvedValueOnce(jsonResponse(models));
      await connector.refreshModels();
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.openai.com/v1/models');
      expect(connector.getCapabilities().models).toEqual(['gpt-4.1-mini', 'gpt-4.1']);
    });
  });

  describe('request and model allowlist', () => {
    it('fails closed without a configured key before transport', async () => {
      const { OpenAiConnector } = await loadModule();
      delete process.env.OPENAI_API_KEY;
      const result = await new OpenAiConnector().moderate({ input: 'safe synthetic text' });
      expect(result).toMatchObject({
        status: 'error',
        results: [],
        error: { type: 'auth_error', retryable: false },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['string', 'synthetic text', 1],
      ['string array', ['first', 'second'], 2],
      ['typed text', [{ type: 'text', text: 'synthetic text' }], 1],
      [
        'typed image',
        [{ type: 'image_url', image_url: { url: 'https://example.invalid/synthetic.png' } }],
        1,
      ],
      [
        'mixed typed content',
        [
          { type: 'text', text: 'synthetic context' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj' } },
        ],
        1,
      ],
    ] as const)('accepts documented %s input', async (_name, input, resultCount) => {
      const { OpenAiConnector } = await loadModule();
      const raw = providerBody('openai-moderations-success.synthetic.json');
      raw.results = Array.from({ length: resultCount }, () =>
        structuredClone((raw.results as unknown[])[0]),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));
      const result = await new OpenAiConnector().moderate({ input: input as ModerationInput });
      expect(result.status).toBe('success');
      expect(result.results).toHaveLength(resultCount);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ input });
    });

    it('uses only the fixed endpoint, method, bearer header, and allowlisted models', async () => {
      const { OpenAiConnector } = await loadModule();
      const connector = new OpenAiConnector();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(providerBody('openai-moderations-success.synthetic.json')),
      );
      await connector.moderate({ input: 'text', model: 'omni-moderation-latest' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/moderations');
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SYNTHETIC_API_KEY}`,
        },
      });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
        input: 'text',
        model: 'omni-moderation-latest',
      });

      fetchMock.mockResolvedValueOnce(
        jsonResponse(providerBody('openai-moderations-image.synthetic.json')),
      );
      const snapshot = await connector.moderate({
        input: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }],
        model: 'omni-moderation-2024-09-26',
      });
      expect(snapshot.status).toBe('success');
      expect(snapshot.model).toBe('omni-moderation-2024-09-26');
    });

    it.each([
      '',
      [],
      ['ok', ''],
      ['raw', { type: 'text', text: 'object' }],
      [{ type: 'audio', audio_url: { url: 'https://example.invalid/audio.wav' } }],
      [{ type: 'text', text: 'ok', extra: true }],
      [{ type: 'image_url', image_url: { url: 'http://example.invalid/image.png' } }],
      [{ type: 'image_url', image_url: { url: 'data:image/png;base64,***' } }],
    ])('rejects invalid input %# before transport', async (input) => {
      const { OpenAiConnector } = await loadModule();
      const result = await new OpenAiConnector().moderate({ input: input as ModerationInput });
      expect(result).toMatchObject({
        status: 'error',
        results: [],
        error: { type: 'validation_error', retryable: false },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['text-moderation-latest', 'text-moderation-007', 'unknown-model']) (
      'rejects legacy or unknown model %s before transport',
      async (model) => {
        const { OpenAiConnector } = await loadModule();
        const result = await new OpenAiConnector().moderate({ input: 'text', model });
        expect(result.error?.type).toBe('validation_error');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('rejects cyclic, over-deep, over-count, and over-20MB data inputs', async () => {
      const { OpenAiConnector } = await loadModule();
      const connector = new OpenAiConnector();
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);
      const deep: Record<string, unknown> = { type: 'text', text: 'ok' };
      let cursor = deep;
      for (let index = 0; index < 70; index++) {
        cursor.next = {};
        cursor = cursor.next as Record<string, unknown>;
      }
      const tooMany = Array.from({ length: 2_049 }, () => 'text');
      const over20Mb = `data:image/png;base64,${'A'.repeat(27_962_032)}`;

      for (const input of [cyclic, [deep], tooMany, [{ type: 'image_url', image_url: { url: over20Mb } }]]) {
        const result = await connector.moderate({ input: input as ModerationInput });
        expect(result.error?.type).toBe('validation_error');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fixed-category normalization', () => {
    it('reconstructs all documented fields and image applicability safely', async () => {
      const { OpenAiConnector } = await loadModule();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(providerBody('openai-moderations-image.synthetic.json')),
      );
      const result = await new OpenAiConnector().moderate({
        input: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }],
      });
      expect(result.status).toBe('success');
      expect(result.results[0].flagged).toBe(true);
      expect(Object.keys(result.results[0].categories)).toEqual(CATEGORY_KEYS);
      expect(Object.keys(result.results[0].categoryScores)).toEqual(CATEGORY_KEYS);
      expect(Object.keys(result.results[0].categoryAppliedInputTypes)).toEqual(CATEGORY_KEYS);
      expect(result.results[0].categoryScores.harassment).toBe(0);
      expect(result.results[0].categoryAppliedInputTypes.harassment).toEqual([]);
      expect(result.results[0].categoryAppliedInputTypes.violence).toEqual(['image']);
    });

    it('preserves one result per string input and one aggregate multimodal result', async () => {
      const { OpenAiConnector } = await loadModule();
      const raw = providerBody('openai-moderations-success.synthetic.json');
      raw.results = [
        structuredClone((raw.results as unknown[])[0]),
        structuredClone((raw.results as unknown[])[0]),
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));
      const strings = await new OpenAiConnector().moderate({ input: ['one', 'two'] });
      expect(strings.results).toHaveLength(2);

      fetchMock.mockResolvedValueOnce(
        jsonResponse(providerBody('openai-moderations-image.synthetic.json')),
      );
      const multimodal = await new OpenAiConnector().moderate({
        input: [
          { type: 'text', text: 'context' },
          { type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } },
        ],
      });
      expect(multimodal.results).toHaveLength(1);
    });

    it.each([
      ['flagged disagreement', (raw: Record<string, unknown>) => {
        ((raw.results as Array<Record<string, unknown>>)[0]).flagged = false;
      }],
      ['missing category', (raw: Record<string, unknown>) => {
        delete (((raw.results as Array<Record<string, unknown>>)[0]).categories as Record<string, unknown>).hate;
      }],
      ['out-of-range score', (raw: Record<string, unknown>) => {
        ((((raw.results as Array<Record<string, unknown>>)[0]).category_scores as Record<string, unknown>)).violence = 2;
      }],
      ['unknown input type', (raw: Record<string, unknown>) => {
        ((((raw.results as Array<Record<string, unknown>>)[0]).category_applied_input_types as Record<string, unknown>)).violence = ['video'];
      }],
      ['duplicate input type', (raw: Record<string, unknown>) => {
        ((((raw.results as Array<Record<string, unknown>>)[0]).category_applied_input_types as Record<string, unknown>)).violence = ['text', 'text'];
      }],
      ['disallowed response model', (raw: Record<string, unknown>) => {
        raw.model = 'legacy-model';
      }],
      ['hostile prototype key', (raw: Record<string, unknown>) => {
        ((raw.results as Array<Record<string, unknown>>)[0]).categories = JSON.parse(
          '{"__proto__":{"polluted":true}}',
        ) as Record<string, unknown>;
      }],
    ] as const)('fails closed on malformed response: %s', async (_name, mutate) => {
      const { OpenAiConnector } = await loadModule();
      const raw = providerBody('openai-moderations-success.synthetic.json');
      mutate(raw);
      fetchMock.mockResolvedValueOnce(jsonResponse(raw));
      const result = await new OpenAiConnector().moderate({ input: 'text' });
      expect(result).toMatchObject({
        status: 'error',
        results: [],
        error: { type: 'malformed_response', retryable: false },
      });
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
  });

  describe('bounded errors, timeout, and redaction', () => {
    it.each([
      [400, 'validation_error', 'error'],
      [422, 'validation_error', 'error'],
      [401, 'auth_error', 'error'],
      [403, 'auth_error', 'error'],
      [429, 'rate_limited', 'rate_limited'],
      [500, 'server_error', 'error'],
      [503, 'server_error', 'error'],
      [418, 'http_error', 'error'],
    ] as const)('normalizes HTTP %s as %s', async (status, type, resultStatus) => {
      const { OpenAiConnector } = await loadModule();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(providerBody('openai-moderations-error.synthetic.json'), status),
      );
      const result = await new OpenAiConnector().moderate({ input: 'text' });
      expect(result).toMatchObject({ status: resultStatus, results: [], error: { type } });
      expect(JSON.stringify(result)).not.toContain(SYNTHETIC_API_KEY);
      expect(result.error?.message).toContain('[REDACTED]');
    });

    it('normalizes abort as timeout and ordinary rejection as a redacted network error', async () => {
      const { OpenAiConnector } = await loadModule();
      const connector = new OpenAiConnector();
      fetchMock.mockRejectedValueOnce(new DOMException(`aborted ${SYNTHETIC_API_KEY}`, 'AbortError'));
      const timeout = await connector.moderate({ input: 'text', timeout: 1 });
      expect(timeout).toMatchObject({
        status: 'timeout',
        error: { type: 'timeout', retryable: true },
      });
      expect(JSON.stringify(timeout)).not.toContain(SYNTHETIC_API_KEY);

      fetchMock.mockRejectedValueOnce(new Error(`network ${SYNTHETIC_API_KEY}`));
      const network = await connector.moderate({ input: 'text' });
      expect(network.error?.type).toBe('network_error');
      expect(JSON.stringify(network)).not.toContain(SYNTHETIC_API_KEY);
    });

    it('rejects malformed and oversized response bodies without disclosure', async () => {
      const { OpenAiConnector } = await loadModule();
      const connector = new OpenAiConnector();
      const malformed = loadFixture('openai-moderations-malformed.synthetic.json').raw;
      fetchMock.mockResolvedValueOnce(new Response(malformed as string, { status: 200 }));
      const badJson = await connector.moderate({ input: 'text' });
      expect(badJson.error?.type).toBe('malformed_response');

      fetchMock.mockResolvedValueOnce(new Response('x'.repeat(4_194_305), { status: 200 }));
      const oversized = await connector.moderate({ input: 'text' });
      expect(oversized.error?.type).toBe('malformed_response');
      expect(JSON.stringify(oversized)).not.toContain(SYNTHETIC_API_KEY);
    });

    it('does not traverse cyclic, deep, or hostile thrown payloads', async () => {
      const { OpenAiConnector } = await loadModule();
      const connector = new OpenAiConnector();
      const cyclic: Record<string, unknown> = { message: SYNTHETIC_API_KEY };
      cyclic.self = cyclic;
      fetchMock.mockRejectedValueOnce(cyclic);
      const cyclicResult = await connector.moderate({ input: 'text' });
      expect(cyclicResult.error?.type).toBe('network_error');
      expect(JSON.stringify(cyclicResult)).not.toContain(SYNTHETIC_API_KEY);

      const deep: Record<string, unknown> = { secret: SYNTHETIC_API_KEY };
      let cursor = deep;
      for (let index = 0; index < 100; index++) {
        cursor.next = {};
        cursor = cursor.next as Record<string, unknown>;
      }
      fetchMock.mockRejectedValueOnce(deep);
      const deepResult = await connector.moderate({ input: 'text' });
      expect(deepResult.error?.type).toBe('network_error');
      expect(JSON.stringify(deepResult)).not.toContain(SYNTHETIC_API_KEY);
    });
  });

  it('records exact deterministic synthetic provenance for every provider-shaped fixture', () => {
    const names = [
      'openai-moderations-success.synthetic.json',
      'openai-moderations-image.synthetic.json',
      'openai-moderations-error.synthetic.json',
      'openai-moderations-malformed.synthetic.json',
    ];
    for (const name of names) {
      expect(loadFixture(name)._fixture_provenance).toContain(
        'Handwritten deterministic synthetic fixture',
      );
    }
    const readme = readFileSync(resolve(FIXTURE_ROOT, 'openai-moderations-README.md'), 'utf8');
    expect(readme).toContain('No fixture was captured from a provider');
    expect(readme).toContain('No credential, account, or paid/live provider interaction was used');
  });
});
