import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VertexAiEmbeddingsConnector,
  VertexAiEmbeddingsError,
  type VertexAiEmbeddingsAuth,
} from './vertex-ai-embeddings.connector';

const FIXTURE_DIR = resolve(
  __dirname,
  '../../../../test/fixtures/embedding/vertex',
);
const ACCESS_TOKEN = 'synthetic-task-access-token';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as unknown;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('VertexAiEmbeddingsConnector', () => {
  let auth: VertexAiEmbeddingsAuth;
  let getAccessToken: ReturnType<typeof vi.fn>;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let connector: VertexAiEmbeddingsConnector;

  beforeEach(() => {
    getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN);
    auth = {
      projectIdValue: 'synthetic-project-123',
      locationValue: 'us-central1',
      getAccessToken,
    };
    fetchImpl = vi.fn();
    connector = new VertexAiEmbeddingsConnector(auth, fetchImpl as typeof fetch);
  });

  it('declares only the documentation-backed Vertex AI embedding boundary', () => {
    expect(connector.getCapabilities()).toEqual({
      provider: 'vertex-ai',
      operation: 'embeddings',
      endpoint: 'regional-publisher-predict',
      discovery: 'documentation-static',
      textModels: [
        'gemini-embedding-001',
        'text-embedding-005',
        'text-multilingual-embedding-002',
      ],
      multimodalModels: ['multimodalembedding@001'],
    });
  });

  it('builds the regional publisher text request and normalizes documented statistics', async () => {
    fetchImpl.mockResolvedValueOnce(response(fixture('text-success.synthetic.json')));

    const result = await connector.embedText({
      model: 'gemini-embedding-001',
      instances: [
        {
          content: 'synthetic document',
          taskType: 'RETRIEVAL_DOCUMENT',
          title: 'Synthetic title',
        },
      ],
      parameters: { autoTruncate: false, outputDimensionality: 256 },
    });

    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/synthetic-project-123/locations/us-central1/publishers/google/models/gemini-embedding-001:predict',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      instances: [
        {
          content: 'synthetic document',
          task_type: 'RETRIEVAL_DOCUMENT',
          title: 'Synthetic title',
        },
      ],
      parameters: { autoTruncate: false, outputDimensionality: 256 },
    });
    expect(result).toEqual({
      provider: 'vertex-ai',
      model: 'gemini-embedding-001',
      embeddings: [
        {
          values: [0.125, -0.25, 0.5],
          statistics: { tokenCount: 7, truncated: false },
        },
      ],
      deployedModelId: 'synthetic-text-deployment',
    });
  });

  it.each(['text-embedding-005', 'text-multilingual-embedding-002'] as const)(
    'accepts the documented text model %s',
    async (model) => {
      fetchImpl.mockResolvedValueOnce(response(fixture('text-success.synthetic.json')));
      const result = await connector.embedText({ model, instances: [{ content: 'text' }] });
      expect(result.model).toBe(model);
    },
  );

  it('rejects unsupported text models before auth or fetch', async () => {
    await expect(
      connector.embedText({ model: 'text-embedding-undocumented', instances: [{ content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'VALIDATION_ERROR' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the single-instance gemini-embedding-001 REST contract', async () => {
    await expect(
      connector.embedText({
        model: 'gemini-embedding-001',
        instances: [{ content: 'one' }, { content: 'two' }],
      }),
    ).rejects.toMatchObject({ kind: 'VALIDATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unsafe regional resource segments before auth or fetch', async () => {
    auth = { ...auth, locationValue: 'us-central1.evil.example' };
    connector = new VertexAiEmbeddingsConnector(auth, fetchImpl as typeof fetch);
    await expect(
      connector.embedText({ model: 'gemini-embedding-001', instances: [{ content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'VALIDATION_ERROR' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on an empty OAuth token without sending a request', async () => {
    getAccessToken.mockResolvedValueOnce('');
    await expect(
      connector.embedText({ model: 'gemini-embedding-001', instances: [{ content: 'x' }] }),
    ).rejects.toMatchObject({ kind: 'AUTH_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends one documented multimodal instance and normalizes each modality', async () => {
    fetchImpl.mockResolvedValueOnce(response(fixture('multimodal-success.synthetic.json')));

    const result = await connector.embedMultimodal({
      model: 'multimodalembedding@001',
      instance: {
        text: 'synthetic scene',
        image: { gcsUri: 'gs://synthetic-bucket/image.png', mimeType: 'image/png' },
        video: {
          bytesBase64Encoded: 'c3ludGhldGljLXZpZGVv',
          videoSegmentConfig: { startOffsetSec: 0, endOffsetSec: 8, intervalSec: 4 },
        },
      },
      dimension: 256,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      instances: [
        {
          text: 'synthetic scene',
          image: { gcsUri: 'gs://synthetic-bucket/image.png', mimeType: 'image/png' },
          video: {
            bytesBase64Encoded: 'c3ludGhldGljLXZpZGVv',
            videoSegmentConfig: { startOffsetSec: 0, endOffsetSec: 8, intervalSec: 4 },
          },
        },
      ],
      parameters: { dimension: 256 },
    });
    const instance = (body.instances as Array<Record<string, unknown>>)[0];
    expect(Array.isArray(instance.video)).toBe(false);
    expect(result).toEqual({
      provider: 'vertex-ai',
      model: 'multimodalembedding@001',
      textEmbedding: [0.1, 0.2, 0.3],
      imageEmbedding: [0.4, 0.5, 0.6],
      videoEmbeddings: [{ startOffsetSec: 0, endOffsetSec: 8, embedding: [0.7, 0.8, 0.9] }],
      deployedModelId: 'synthetic-multimodal-deployment',
    });
  });

  it('rejects an image with both documented source alternatives', async () => {
    await expect(
      connector.embedMultimodal({
        model: 'multimodalembedding@001',
        instance: {
          image: {
            bytesBase64Encoded: 'c3ludGhldGlj',
            gcsUri: 'gs://synthetic-bucket/image.png',
          },
        },
      }),
    ).rejects.toMatchObject({ kind: 'VALIDATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { instance: {}, dimension: undefined },
    { instance: { image: { gcsUri: 'gs://synthetic/image.gif', mimeType: 'image/gif' } } },
    { instance: { text: 'x' }, dimension: 1024 },
    {
      instance: {
        video: {
          gcsUri: 'gs://synthetic/video.mp4',
          videoSegmentConfig: { intervalSec: 3 },
        },
      },
    },
  ])('rejects undocumented multimodal input %# before fetch', async (request) => {
    await expect(
      connector.embedMultimodal({
        model: 'multimodalembedding@001',
        ...request,
      } as Parameters<VertexAiEmbeddingsConnector['embedMultimodal']>[0]),
    ).rejects.toMatchObject({ kind: 'VALIDATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizes Google Cloud provider errors and redacts exact and bearer-shaped tokens', async () => {
    fetchImpl.mockResolvedValueOnce(response(fixture('provider-error.synthetic.json'), 401));

    const caught = await connector
      .embedText({ model: 'gemini-embedding-001', instances: [{ content: 'x' }] })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(VertexAiEmbeddingsError);
    expect(caught).toMatchObject({
      kind: 'PROVIDER_ERROR',
      httpStatus: 401,
      providerCode: 401,
      providerStatus: 'UNAUTHENTICATED',
    });
    expect((caught as Error).message).toContain('[REDACTED]');
    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
    expect((caught as Error).message).not.toContain('synthetic-provider-bearer');
  });

  it('does not echo bearer material from a malformed success payload', async () => {
    fetchImpl.mockResolvedValueOnce(response(fixture('malformed-success.synthetic.json')));

    const caught = await connector
      .embedText({ model: 'gemini-embedding-001', instances: [{ content: 'x' }] })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(VertexAiEmbeddingsError);
    expect(caught).toMatchObject({ kind: 'MALFORMED_SUCCESS' });
    expect((caught as Error).message).not.toContain(ACCESS_TOKEN);
    expect((caught as Error).message).not.toContain('synthetic-malformed-success-bearer');
    expect((caught as Error).message).not.toContain('Bearer');
  });
});
