import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerplexityConnector, PERPLEXITY_SONAR_MODELS } from './perplexity.connector';

describe('PerplexityConnector', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let connector: PerplexityConnector;

  beforeEach(() => {
    process.env.PERPLEXITY_API_KEY = 'pplx-test-key';
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    connector = new PerplexityConnector();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PERPLEXITY_API_KEY;
  });

  it('uses the native Sonar endpoint and Bearer authentication', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse(successFixture));
    await connector.execute({ prompt: 'What changed?' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.perplexity.ai/v1/sonar',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer pplx-test-key' }),
      }),
    );
  });

  it('forwards the officially documented Sonar options without renaming them', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse(successFixture));
    const options = {
      max_tokens: 512,
      stream: false,
      stop: ['END'],
      temperature: 0.2,
      top_p: 0.8,
      response_format: { type: 'text' },
      web_search_options: { search_context_size: 'high' },
      search_mode: 'academic',
      return_images: true,
      return_related_questions: true,
      enable_search_classifier: true,
      disable_search: false,
      search_domain_filter: ['example.org'],
      search_language_filter: ['en'],
      search_recency_filter: 'week',
      search_after_date_filter: '01/01/2026',
      search_before_date_filter: '07/11/2026',
      last_updated_after_filter: '01/01/2026',
      last_updated_before_filter: '07/11/2026',
      image_format_filter: ['png'],
      image_domain_filter: ['images.example.org'],
      stream_mode: 'full',
      reasoning_effort: 'high',
      language_preference: 'en',
    };
    await connector.execute({ prompt: 'Research', model: 'sonar-pro', extra: options });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'sonar-pro',
      messages: [{ role: 'user', content: 'Research' }],
      ...options,
    });
  });

  it('preserves citations, search results, images, related questions, and native usage', async () => {
    fetchSpy.mockResolvedValueOnce(okResponse(successFixture));
    const response = await connector.execute({ prompt: 'What changed?' });

    expect(response.result).toBe('Answer [1]');
    expect(response.structured).toEqual(successFixture);
    expect(response.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
  });

  it('accepts documented usage responses with optional citation and reasoning fields absent', async () => {
    const fixture = {
      ...successFixture,
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    };
    fetchSpy.mockResolvedValueOnce(okResponse(fixture));
    const response = await connector.execute({ prompt: 'Short answer' });
    expect(response.status).toBe('success');
    expect(response.structured).toEqual(fixture);
  });

  it.each([
    [401, 'auth_error'],
    [403, 'permission_error'],
    [422, 'validation_error'],
    [429, 'rate_limited'],
    [500, 'server_error'],
  ])('maps HTTP %i to %s', async (status, type) => {
    fetchSpy.mockResolvedValueOnce(
      errorResponse(status, status === 422 ? validationFixture : { error: 'failed' }),
    );
    const response = await connector.execute({ prompt: 'fail' });
    expect(response.error?.type).toBe(type);
  });

  it('preserves 422 validation details', async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(422, validationFixture));
    const response = await connector.execute({ prompt: 'fail' });
    expect(response.error?.details).toEqual(validationFixture.detail);
  });

  it('exposes Retry-After seconds for 429 responses', async () => {
    fetchSpy.mockResolvedValueOnce(
      errorResponse(429, { error: 'rate limit' }, { 'retry-after': '12' }),
    );
    const response = await connector.execute({ prompt: 'fail' });
    expect(response.error?.retryAfter).toBe(12_000);
  });

  it('uses only the four officially enumerated Sonar models without discovery', () => {
    expect(PERPLEXITY_SONAR_MODELS).toEqual([
      'sonar',
      'sonar-pro',
      'sonar-reasoning-pro',
      'sonar-deep-research',
    ]);
    expect(connector.getCapabilities().models).toEqual(PERPLEXITY_SONAR_MODELS);
  });
});

const successFixture = {
  id: 'pplx-1',
  model: 'sonar',
  created: 1,
  object: 'chat.completion',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Answer [1]' }, finish_reason: 'stop' },
  ],
  citations: ['https://example.org/source'],
  search_results: [
    { title: 'Source', url: 'https://example.org/source', snippet: 'Evidence', source: 'web' },
  ],
  images: [{ image_url: 'https://example.org/image.png', origin_url: 'https://example.org' }],
  related_questions: ['What next?'],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, num_search_queries: 1 },
};

const validationFixture = {
  detail: [{ loc: ['body', 'model'], msg: 'Field required', type: 'missing' }],
};

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}
