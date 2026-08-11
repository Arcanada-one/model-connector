import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GooglePerspectiveConnector,
  GooglePerspectiveError,
  GooglePerspectiveTransportTimeoutError,
} from './google-perspective.connector';
import type {
  AnalyzeCommentInput,
  PerspectiveTransportRequest,
  PerspectiveTransportResponse,
  ScoreType,
} from './types';

const API_KEY = 'synthetic/key+secret?&=';
const ENCODED_API_KEY = 'synthetic%2Fkey%2Bsecret%3F%26%3D';
const FIXED_URL =
  `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${ENCODED_API_KEY}`;
const BEFORE_SUNSET = new Date('2026-07-20T00:00:00.000Z');
const LAST_ALLOWED_INSTANT = new Date('2026-12-31T23:59:59.999Z');
const RETIRED_INSTANT = new Date('2027-01-01T00:00:00.000Z');
const FIXTURE_DIR = join(__dirname, 'fixtures');

const SUCCESS_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'analyze-success.synthetic.json'), 'utf8'),
) as unknown;
const ERROR_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'provider-error.synthetic.json'), 'utf8'),
) as unknown;

const minimalInput = (): AnalyzeCommentInput => ({
  comment: { text: 'test' },
  requestedAttributes: { TOXICITY: {} },
});

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

const response = (
  body: unknown = SUCCESS_FIXTURE,
  overrides: Partial<PerspectiveTransportResponse> = {},
): PerspectiveTransportResponse => {
  const bodyBytes = overrides.bodyBytes ?? jsonBytes(body);
  return {
    status: 200,
    contentType: 'application/json',
    body,
    ...overrides,
    bodyBytes,
  };
};

const makeHarness = (
  providerResponse: PerspectiveTransportResponse = response(),
  options: {
    now?: () => Date;
    allowProviderStorage?: boolean;
    apiKey?: string;
    timeoutMs?: number;
  } = {},
) => {
  const transport = vi.fn(
    async (_request: PerspectiveTransportRequest): Promise<PerspectiveTransportResponse> =>
      providerResponse,
  );
  const connector = new GooglePerspectiveConnector({
    apiKey: options.apiKey ?? API_KEY,
    transport,
    now: options.now ?? (() => new Date(BEFORE_SUNSET)),
    allowProviderStorage: options.allowProviderStorage,
    timeoutMs: options.timeoutMs,
  });
  return { connector, transport };
};

const expectPerspectiveError = async (
  operation: Promise<unknown>,
  category: GooglePerspectiveError['category'],
): Promise<GooglePerspectiveError> => {
  try {
    await operation;
    throw new Error('expected GooglePerspectiveError');
  } catch (error) {
    expect(error).toBeInstanceOf(GooglePerspectiveError);
    const perspectiveError = error as GooglePerspectiveError;
    expect(perspectiveError.category).toBe(category);
    return perspectiveError;
  }
};

const expectConstructorError = (factory: () => unknown): GooglePerspectiveError => {
  try {
    factory();
    throw new Error('expected GooglePerspectiveError');
  } catch (error) {
    expect(error).toBeInstanceOf(GooglePerspectiveError);
    const perspectiveError = error as GooglePerspectiveError;
    expect(perspectiveError.category).toBe('validation');
    return perspectiveError;
  }
};

describe('CONN-0291 Google Perspective API dormant connector', () => {
  describe('construction, fixed target, and injected transport', () => {
    it('requires a nonempty bounded API key', () => {
      expectConstructorError(
        () =>
          new GooglePerspectiveConnector({
            apiKey: '',
            transport: vi.fn(),
            now: () => new Date(BEFORE_SUNSET),
          }),
      );
      expectConstructorError(
        () =>
          new GooglePerspectiveConnector({
            apiKey: 'x'.repeat(4097),
            transport: vi.fn(),
            now: () => new Date(BEFORE_SUNSET),
          }),
      );
    });

    it('requires explicit transport and clock injection', () => {
      expectConstructorError(
        () =>
          new GooglePerspectiveConnector({
            apiKey: API_KEY,
            transport: undefined as never,
            now: () => new Date(BEFORE_SUNSET),
          }),
      );
      expectConstructorError(
        () =>
          new GooglePerspectiveConnector({
            apiKey: API_KEY,
            transport: vi.fn(),
            now: undefined as never,
          }),
      );
    });

    it('constructs the exact documented method, host, path, version, query, headers, and body', async () => {
      const { connector, transport } = makeHarness();

      await connector.analyze(minimalInput());

      expect(transport).toHaveBeenCalledOnce();
      const request = transport.mock.calls[0][0];
      expect(request).toEqual({
        url: FIXED_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: { text: 'test' },
          requestedAttributes: { TOXICITY: {} },
          doNotStore: true,
        }),
        redirect: 'error',
        timeoutMs: 10_000,
      });
      const parsedUrl = new URL(request.url);
      expect(parsedUrl.protocol).toBe('https:');
      expect(parsedUrl.hostname).toBe('commentanalyzer.googleapis.com');
      expect(parsedUrl.pathname).toBe('/v1alpha1/comments:analyze');
      expect([...parsedUrl.searchParams.keys()]).toEqual(['key']);
      expect(parsedUrl.searchParams.get('key')).toBe(API_KEY);
    });

    it('uses the bounded caller timeout and never references global fetch', async () => {
      const fetchSentinel = vi.fn(() => {
        throw new Error('global fetch must remain unused');
      });
      vi.stubGlobal('fetch', fetchSentinel);
      try {
        const { connector, transport } = makeHarness(response(), { timeoutMs: 1234 });
        await connector.analyze(minimalInput());
        expect(transport.mock.calls[0][0].timeoutMs).toBe(1234);
        expect(fetchSentinel).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('rejects invalid timeout bounds during construction', () => {
      expectConstructorError(() => makeHarness(response(), { timeoutMs: 0 }));
      expectConstructorError(() => makeHarness(response(), { timeoutMs: 30_001 }));
    });

    it('serializes a copied request before transport and makes no automatic retry', async () => {
      let resolveTransport!: (value: PerspectiveTransportResponse) => void;
      const transport = vi.fn(
        (_request: PerspectiveTransportRequest) =>
          new Promise<PerspectiveTransportResponse>((resolve) => {
            resolveTransport = resolve;
          }),
      );
      const connector = new GooglePerspectiveConnector({
        apiKey: API_KEY,
        transport,
        now: () => new Date(BEFORE_SUNSET),
      });
      const input = minimalInput();
      const pending = connector.analyze(input);
      input.comment.text = 'caller mutation';
      resolveTransport(response());
      await pending;

      expect(transport).toHaveBeenCalledOnce();
      expect(JSON.parse(transport.mock.calls[0][0].body).comment.text).toBe('test');
    });
  });

  describe('sunset boundary', () => {
    it('permits the last millisecond documented inside 2026', async () => {
      const { connector, transport } = makeHarness(response(), {
        now: () => new Date(LAST_ALLOWED_INSTANT),
      });
      await connector.analyze(minimalInput());
      expect(transport).toHaveBeenCalledOnce();
    });

    it('fails closed at 2027-01-01 before transport', async () => {
      const { connector, transport } = makeHarness(response(), {
        now: () => new Date(RETIRED_INSTANT),
      });
      await expectPerspectiveError(connector.analyze(minimalInput()), 'lifecycle');
      expect(transport).not.toHaveBeenCalled();
    });

    it('rejects an invalid injected clock result before transport', async () => {
      const { connector, transport } = makeHarness(response(), {
        now: () => new Date(Number.NaN),
      });
      await expectPerspectiveError(connector.analyze(minimalInput()), 'lifecycle');
      expect(transport).not.toHaveBeenCalled();
    });
  });

  describe('strict AnalyzeComment request construction', () => {
    it.each(['TEXT_TYPE_UNSPECIFIED', 'PLAIN_TEXT', 'HTML'] as const)(
      'preserves documented TextEntry type %s',
      async (type) => {
        const { connector, transport } = makeHarness();
        await connector.analyze({
          ...minimalInput(),
          comment: { text: 'test', type },
        });
        expect(JSON.parse(transport.mock.calls[0][0].body).comment).toEqual({ text: 'test', type });
      },
    );

    it('preserves TextEntry type omission', async () => {
      const { connector, transport } = makeHarness();
      await connector.analyze(minimalInput());
      expect(JSON.parse(transport.mock.calls[0][0].body).comment).toEqual({ text: 'test' });
    });

    it.each([
      { comment: { text: '' } },
      { comment: { text: 'test', type: 'MARKDOWN' } },
      { comment: { text: 'test', extra: true } },
      { comment: { text: 'x'.repeat(32_769) } },
    ])('rejects invalid comment TextEntry %#', async (override) => {
      const { connector, transport } = makeHarness();
      await expectPerspectiveError(
        connector.analyze({ ...minimalInput(), ...override } as AnalyzeCommentInput),
        'validation',
      );
      expect(transport).not.toHaveBeenCalled();
    });

    it.each([
      'SCORE_TYPE_UNSPECIFIED',
      'PROBABILITY',
      'STD_DEV_SCORE',
      'PERCENTILE',
      'RAW',
    ] as ScoreType[])('preserves documented AttributeParameters scoreType %s', async (scoreType) => {
      const { connector, transport } = makeHarness();
      await connector.analyze({
        ...minimalInput(),
        requestedAttributes: { TOXICITY: { scoreType } },
      });
      expect(JSON.parse(transport.mock.calls[0][0].body).requestedAttributes).toEqual({
        TOXICITY: { scoreType },
      });
    });

    it('preserves omitted AttributeParameters and valid score thresholds', async () => {
      const first = makeHarness();
      await first.connector.analyze(minimalInput());
      expect(JSON.parse(first.transport.mock.calls[0][0].body).requestedAttributes).toEqual({
        TOXICITY: {},
      });

      const second = makeHarness();
      await second.connector.analyze({
        ...minimalInput(),
        requestedAttributes: { TOXICITY: { scoreThreshold: 0.5, scoreType: 'PROBABILITY' } },
      });
      expect(JSON.parse(second.transport.mock.calls[0][0].body).requestedAttributes).toEqual({
        TOXICITY: { scoreThreshold: 0.5, scoreType: 'PROBABILITY' },
      });
    });

    it.each([
      { requestedAttributes: {} },
      { requestedAttributes: { SEVERE_TOXICITY: {} } },
      { requestedAttributes: { TOXICITY: {}, SPAM: {} } },
      { requestedAttributes: { TOXICITY: { scoreType: 'SAFE' } } },
      { requestedAttributes: { TOXICITY: { scoreThreshold: Number.NaN } } },
      { requestedAttributes: { TOXICITY: { scoreThreshold: 1.1 } } },
      { requestedAttributes: { TOXICITY: { unknown: true } } },
    ])('rejects unsupported or malformed requestedAttributes %#', async (override) => {
      const { connector, transport } = makeHarness();
      await expectPerspectiveError(
        connector.analyze({ ...minimalInput(), ...override } as AnalyzeCommentInput),
        'validation',
      );
      expect(transport).not.toHaveBeenCalled();
    });

    it('rejects caller-supplied languages and preserves omission', async () => {
      const rejected = makeHarness();
      await expectPerspectiveError(
        rejected.connector.analyze({ ...minimalInput(), languages: ['en'] }),
        'validation',
      );
      expect(rejected.transport).not.toHaveBeenCalled();

      const omitted = makeHarness();
      await omitted.connector.analyze(minimalInput());
      expect(JSON.parse(omitted.transport.mock.calls[0][0].body)).not.toHaveProperty('languages');
    });

    it('serializes context.entries and articleAndParentComment separately', async () => {
      const entries = makeHarness();
      await entries.connector.analyze({
        ...minimalInput(),
        context: { entries: [{ text: 'first' }, { text: 'second', type: 'PLAIN_TEXT' }] },
      });
      expect(JSON.parse(entries.transport.mock.calls[0][0].body).context).toEqual({
        entries: [{ text: 'first' }, { text: 'second', type: 'PLAIN_TEXT' }],
      });

      const article = makeHarness();
      await article.connector.analyze({
        ...minimalInput(),
        context: {
          articleAndParentComment: {
            article: { text: 'article', type: 'HTML' },
            parentComment: { text: 'parent' },
          },
        },
      });
      expect(JSON.parse(article.transport.mock.calls[0][0].body).context).toEqual({
        articleAndParentComment: {
          article: { text: 'article', type: 'HTML' },
          parentComment: { text: 'parent' },
        },
      });
    });

    it.each([
      { context: {} },
      { context: { entries: [], articleAndParentComment: { article: { text: 'article' } } } },
      { context: { entries: [{ text: 'first' }], extra: true } },
      { context: { articleAndParentComment: {} } },
      { context: { articleAndParentComment: { article: { text: '' } } } },
    ])('rejects malformed context %#', async (override) => {
      const { connector, transport } = makeHarness();
      await expectPerspectiveError(
        connector.analyze({ ...minimalInput(), ...override } as AnalyzeCommentInput),
        'validation',
      );
      expect(transport).not.toHaveBeenCalled();
    });

    it('preserves documented optional client/community/session fields and omission', async () => {
      const supplied = makeHarness();
      await supplied.connector.analyze({
        ...minimalInput(),
        clientToken: 'synthetic-client-token',
        communityId: 'synthetic-community',
        sessionId: 'synthetic-session',
      });
      const suppliedBody = JSON.parse(supplied.transport.mock.calls[0][0].body);
      expect(suppliedBody).toMatchObject({
        clientToken: 'synthetic-client-token',
        communityId: 'synthetic-community',
        sessionId: 'synthetic-session',
      });

      const omitted = makeHarness();
      await omitted.connector.analyze(minimalInput());
      const omittedBody = JSON.parse(omitted.transport.mock.calls[0][0].body);
      expect(omittedBody).not.toHaveProperty('clientToken');
      expect(omittedBody).not.toHaveProperty('communityId');
      expect(omittedBody).not.toHaveProperty('sessionId');
    });

    it.each([true, false])('preserves spanAnnotations=%s', async (spanAnnotations) => {
      const { connector, transport } = makeHarness();
      await connector.analyze({ ...minimalInput(), spanAnnotations });
      expect(JSON.parse(transport.mock.calls[0][0].body).spanAnnotations).toBe(spanAnnotations);
    });

    it('omits spanAnnotations when absent', async () => {
      const { connector, transport } = makeHarness();
      await connector.analyze(minimalInput());
      expect(JSON.parse(transport.mock.calls[0][0].body)).not.toHaveProperty('spanAnnotations');
    });

    it('defaults doNotStore to true and preserves explicit true', async () => {
      const defaulted = makeHarness();
      await defaulted.connector.analyze(minimalInput());
      expect(JSON.parse(defaulted.transport.mock.calls[0][0].body).doNotStore).toBe(true);

      const explicit = makeHarness();
      await explicit.connector.analyze({ ...minimalInput(), doNotStore: true });
      expect(JSON.parse(explicit.transport.mock.calls[0][0].body).doNotStore).toBe(true);
    });

    it('rejects doNotStore false without explicit provider-storage opt-in', async () => {
      const { connector, transport } = makeHarness();
      await expectPerspectiveError(
        connector.analyze({ ...minimalInput(), doNotStore: false }),
        'validation',
      );
      expect(transport).not.toHaveBeenCalled();
    });

    it('preserves false or omission only with explicit provider-storage opt-in', async () => {
      const falseValue = makeHarness(response(), { allowProviderStorage: true });
      await falseValue.connector.analyze({ ...minimalInput(), doNotStore: false });
      expect(JSON.parse(falseValue.transport.mock.calls[0][0].body).doNotStore).toBe(false);

      const omitted = makeHarness(response(), { allowProviderStorage: true });
      await omitted.connector.analyze(minimalInput());
      expect(JSON.parse(omitted.transport.mock.calls[0][0].body)).not.toHaveProperty('doNotStore');
    });

    it.each([
      { model: 'gemini' },
      { endpoint: 'https://example.invalid' },
      { region: 'us-central1' },
      { quotaUser: 'user' },
      { extra: true },
    ])('rejects unknown or cross-provider request fields %#', async (field) => {
      const { connector, transport } = makeHarness();
      await expectPerspectiveError(
        connector.analyze({ ...minimalInput(), ...field } as AnalyzeCommentInput),
        'validation',
      );
      expect(transport).not.toHaveBeenCalled();
    });

    it('rejects inherited, accessor, exotic-prototype, and prototype-pollution request values', async () => {
      const inherited = Object.create({ model: 'gemini' }) as AnalyzeCommentInput;
      Object.assign(inherited, minimalInput());
      const accessor = minimalInput() as AnalyzeCommentInput & { clientToken?: string };
      Object.defineProperty(accessor, 'clientToken', { enumerable: true, get: () => 'secret' });
      const dangerous = JSON.parse(
        '{"comment":{"text":"test"},"requestedAttributes":{"constructor":{}}}',
      ) as AnalyzeCommentInput;

      for (const input of [inherited, accessor, dangerous]) {
        const { connector, transport } = makeHarness();
        await expectPerspectiveError(connector.analyze(input), 'validation');
        expect(transport).not.toHaveBeenCalled();
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('bounded success response parsing and score semantics', () => {
    it('parses the handwritten fixture into safe records without policy interpretation', async () => {
      const { connector } = makeHarness();
      const result = await connector.analyze({
        ...minimalInput(),
        clientToken: 'synthetic-client-token',
        spanAnnotations: true,
      });

      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.getPrototypeOf(result.attributeScores)).toBeNull();
      expect(Object.getPrototypeOf(result.attributeScores.TOXICITY)).toBeNull();
      expect(result.attributeScores.TOXICITY.summaryScore).toEqual({
        value: 0.42,
        type: 'PROBABILITY',
      });
      expect(result.attributeScores.TOXICITY.spanScores).toEqual([
        { begin: 0, end: 4, score: { value: 0.25, type: 'PROBABILITY' } },
        { score: { value: -0.75, type: 'RAW' } },
      ]);
      expect(result.clientToken).toBe('synthetic-client-token');
      expect(result.detectedLanguages).toEqual(['en']);
      expect(result.languages).toEqual(['en']);
      expect(result).not.toHaveProperty('safe');
      expect(result).not.toHaveProperty('moderationDecision');
    });

    it.each([
      ['SCORE_TYPE_UNSPECIFIED', -7],
      ['PROBABILITY', 0.75],
      ['STD_DEV_SCORE', -2.5],
      ['PERCENTILE', 0.25],
      ['RAW', 17.25],
    ] as Array<[ScoreType, number]>)('preserves score type %s and finite value %s', async (type, value) => {
      const body = {
        attributeScores: { TOXICITY: { summaryScore: { type, value } } },
      };
      const { connector } = makeHarness(response(body));
      const result = await connector.analyze(minimalInput());
      expect(result.attributeScores.TOXICITY.summaryScore).toEqual({ type, value });
    });

    it('accepts optional summary/span omission and paired full-text span omission', async () => {
      const body = {
        attributeScores: {
          TOXICITY: {
            spanScores: [{ score: { type: 'PROBABILITY', value: 0.1 } }],
          },
        },
      };
      const { connector } = makeHarness(response(body));
      const result = await connector.analyze(minimalInput());
      expect(result.attributeScores.TOXICITY).not.toHaveProperty('summaryScore');
      expect(result.attributeScores.TOXICITY.spanScores).toEqual([
        { score: { type: 'PROBABILITY', value: 0.1 } },
      ]);
    });

    it('preserves optional top-level response field omission', async () => {
      const body = { attributeScores: { TOXICITY: { summaryScore: { value: 0.1 } } } };
      const { connector } = makeHarness(response(body));
      const result = await connector.analyze(minimalInput());
      expect(result).not.toHaveProperty('clientToken');
      expect(result).not.toHaveProperty('detectedLanguages');
      expect(result).not.toHaveProperty('languages');
    });

    it.each([
      { attributeScores: { TOXICITY: { summaryScore: { type: 'PROBABILITY', value: -0.1 } } } },
      { attributeScores: { TOXICITY: { summaryScore: { type: 'PROBABILITY', value: 1.1 } } } },
      { attributeScores: { TOXICITY: { summaryScore: { type: 'PERCENTILE', value: 2 } } } },
      { attributeScores: { TOXICITY: { summaryScore: { type: 'RAW', value: Number.NaN } } } },
      { attributeScores: { TOXICITY: { summaryScore: { type: 'SAFE', value: 0.1 } } } },
      { attributeScores: { TOXICITY: { summaryScore: { value: '0.1' } } } },
      { attributeScores: { TOXICITY: { spanScores: [{ begin: 3, end: 2, score: { value: 0.1 } }] } } },
      { attributeScores: { TOXICITY: { spanScores: [{ begin: 0, end: 5, score: { value: 0.1 } }] } } },
      { attributeScores: { TOXICITY: { spanScores: [{ begin: 0, score: { value: 0.1 } }] } } },
    ])('rejects malformed score/span response %#', async (body) => {
      const { connector } = makeHarness(response(body));
      await expectPerspectiveError(connector.analyze(minimalInput()), 'response');
    });

    it.each([
      { attributeScores: { SPAM: { summaryScore: { value: 0.1 } } } },
      { attributeScores: { TOXICITY: { summaryScore: { value: 0.1 }, extra: true } } },
      { attributeScores: { TOXICITY: { spanScores: [{ score: { value: 0.1 }, extra: true }] } } },
      { attributeScores: { TOXICITY: { summaryScore: { value: 0.1, extra: true } } } },
      { attributeScores: { TOXICITY: { summaryScore: { value: 0.1 } } }, extra: true },
    ])('rejects unsupported success fields %#', async (body) => {
      const { connector } = makeHarness(response(body));
      await expectPerspectiveError(connector.analyze(minimalInput()), 'response');
    });
  });

  describe('provider failures, timeout, malformed values, and redaction', () => {
    it('returns only bounded safe provider fields and redacts all sensitive fixture text', async () => {
      const { connector } = makeHarness(
        response(ERROR_FIXTURE, { status: 400, bodyBytes: jsonBytes(ERROR_FIXTURE) }),
      );
      const error = await expectPerspectiveError(connector.analyze(minimalInput()), 'provider');

      expect(error.httpStatus).toBe(400);
      expect(error.providerCode).toBe(400);
      expect(error.providerStatus).toBe('INVALID_ARGUMENT');
      const serialized = `${error.name} ${error.message} ${JSON.stringify(error)}`;
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain(ENCODED_API_KEY);
      expect(serialized).not.toContain('commentanalyzer.googleapis.com');
      expect(serialized).not.toContain('test');
      expect(serialized).not.toContain('HANDWRITTEN_SYNTHETIC_ONLY');
      expect(serialized).not.toContain('Synthetic provider text');
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('details');
      expect(error).not.toHaveProperty('body');
      expect(error).not.toHaveProperty('url');
    });

    it.each([
      response({ nope: true }, { status: 400 }),
      response('not an error object', { status: 500, bodyBytes: 19 }),
      response(ERROR_FIXTURE, { status: 302 }),
      response(null, { status: 204, bodyBytes: 0 }),
      response(SUCCESS_FIXTURE, { contentType: 'text/html' }),
    ])('fails closed for malformed errors, redirects, empty success, and content type %#', async (providerResponse) => {
      const { connector } = makeHarness(providerResponse);
      await expectPerspectiveError(
        connector.analyze(minimalInput()),
        providerResponse.status >= 300 ? 'provider' : 'response',
      );
    });

    it('maps the explicit transport timeout marker without leaking its message', async () => {
      const transport = vi.fn(async () => {
        throw new GooglePerspectiveTransportTimeoutError(`timeout ${API_KEY} test`);
      });
      const connector = new GooglePerspectiveConnector({
        apiKey: API_KEY,
        transport,
        now: () => new Date(BEFORE_SUNSET),
      });
      const error = await expectPerspectiveError(connector.analyze(minimalInput()), 'timeout');
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(API_KEY);
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('test');
      expect(transport).toHaveBeenCalledOnce();
    });

    it('maps an arbitrary transport failure without retaining its cause or message', async () => {
      const transport = vi.fn(async () => {
        throw new Error(`transport ${API_KEY} test ${FIXED_URL}`);
      });
      const connector = new GooglePerspectiveConnector({
        apiKey: API_KEY,
        transport,
        now: () => new Date(BEFORE_SUNSET),
      });
      const error = await expectPerspectiveError(connector.analyze(minimalInput()), 'transport');
      const serialized = `${error.message} ${JSON.stringify(error)}`;
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain(ENCODED_API_KEY);
      expect(serialized).not.toContain('test');
      expect(error).not.toHaveProperty('cause');
      expect(transport).toHaveBeenCalledOnce();
    });

    it.each([null, [], 'string', 17, true])('rejects non-object success body %#', async (body) => {
      const { connector } = makeHarness(response(body));
      await expectPerspectiveError(connector.analyze(minimalInput()), 'response');
    });

    it('rejects cyclic, deep, wide, oversized, and prototype-bearing responses', async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      let deep: Record<string, unknown> = {};
      for (let index = 0; index < 20; index += 1) {
        const next: Record<string, unknown> = {};
        deep.next = next;
        deep = next;
      }
      const wide = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, index]));
      const dangerous = JSON.parse(
        '{"attributeScores":{"TOXICITY":{"summaryScore":{"value":0.1,"constructor":{}}}}}',
      ) as unknown;

      for (const providerResponse of [
        response(cyclic, { bodyBytes: 1 }),
        response(deep),
        response(wide),
        response(SUCCESS_FIXTURE, { bodyBytes: 262_145 }),
        response(dangerous),
      ]) {
        const { connector } = makeHarness(providerResponse);
        await expectPerspectiveError(connector.analyze(minimalInput()), 'response');
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects accessor and inherited response objects without invoking accessors', async () => {
      const getter = vi.fn(() => ({ TOXICITY: {} }));
      const accessor: Record<string, unknown> = {};
      Object.defineProperty(accessor, 'attributeScores', { enumerable: true, get: getter });
      const inherited = Object.create({ attributeScores: { TOXICITY: {} } }) as Record<
        string,
        unknown
      >;

      for (const body of [accessor, inherited]) {
        const { connector } = makeHarness(response(body, { bodyBytes: 1 }));
        await expectPerspectiveError(connector.analyze(minimalInput()), 'response');
      }
      expect(getter).not.toHaveBeenCalled();
    });
  });

  describe('handwritten synthetic fixture provenance', () => {
    it.each([
      ['analyze-success.synthetic.json', 'd324c19ce88db23eccb9af512741fefbff6b0e58f393224d9e553bf497a574ac'],
      ['provider-error.synthetic.json', '91e531b3a053bc67e13d106b32523f1f9e88399bc0c5b1371c9e60d716f81c6c'],
    ])('matches the frozen SHA-256 for %s', (file, expected) => {
      const bytes = readFileSync(join(FIXTURE_DIR, file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
    });

    it('declares exact synthetic provenance and prohibits provider claims', () => {
      const provenance = readFileSync(join(FIXTURE_DIR, 'README.md'), 'utf8');
      expect(provenance).toContain('handwritten deterministic synthetic JSON');
      expect(provenance).toContain('never captured, replayed, copied, or');
      expect(provenance).toContain('No Perspective endpoint');
      expect(provenance).toContain('not evidence of provider output');
      expect(provenance).toContain('d324c19ce88db23eccb9af512741fefbff6b0e58f393224d9e553bf497a574ac');
      expect(provenance).toContain('91e531b3a053bc67e13d106b32523f1f9e88399bc0c5b1371c9e60d716f81c6c');
    });
  });
});
