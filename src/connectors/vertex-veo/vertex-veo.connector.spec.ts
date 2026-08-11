import { describe, expect, it, vi } from 'vitest';
import { VertexVeoConnector, type VeoTransport } from './vertex-veo.connector';

describe('VertexVeoConnector', () => {
  const operation = {
    name: 'projects/p/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/op-1',
  };

  it('submits the provider-native request to predictLongRunning', async () => {
    const post = vi.fn().mockResolvedValue(operation);
    const connector = new VertexVeoConnector({ project: 'p', location: 'us-central1' }, { post });
    const body = { instances: [{ prompt: 'A paper boat' }], parameters: { sampleCount: 1 } };

    await expect(connector.predictLongRunning('veo-3.1-generate-001', body, 'oauth-token')).resolves.toEqual(operation);
    expect(post).toHaveBeenCalledWith(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/veo-3.1-generate-001:predictLongRunning',
      body,
      { Authorization: 'Bearer oauth-token', 'Content-Type': 'application/json' },
    );
  });

  it('polls through the model-scoped fetchPredictOperation contract without reshaping', async () => {
    const completed = { ...operation, done: true, response: { videos: [{ gcsUri: 'gs://bucket/out/sample_0.mp4', mimeType: 'video/mp4' }] } };
    const post = vi.fn().mockResolvedValue(completed);
    const connector = new VertexVeoConnector({ project: 'p', location: 'us-central1' }, { post } as VeoTransport);

    await expect(connector.fetchPredictOperation('veo-3.1-generate-001', operation.name, 'oauth-token')).resolves.toEqual(completed);
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/veo-3\.1-generate-001:fetchPredictOperation$/), { operationName: operation.name }, expect.any(Object));
  });

  it.each(['veo-2.0-generate-001', 'veo-3.0-generate-001', 'veo-3.0-fast-generate-001', 'veo-3.1-generate-001', 'veo-3.1-fast-generate-001'])('accepts documented stable model %s', async (model) => {
    const connector = new VertexVeoConnector({ project: 'p', location: 'europe-west4' }, { post: vi.fn().mockResolvedValue(operation) });
    await expect(connector.predictLongRunning(model, { instances: [{ prompt: 'x' }], parameters: {} }, 't')).resolves.toEqual(operation);
  });

  it('rejects preview models and invalid sample counts before transport', async () => {
    const post = vi.fn();
    const connector = new VertexVeoConnector({ project: 'p', location: 'us-central1' }, { post });
    await expect(connector.predictLongRunning('veo-3.1-generate-preview', { instances: [{ prompt: 'x' }], parameters: {} }, 't')).rejects.toThrow(/Unsupported Veo model/);
    await expect(connector.predictLongRunning('veo-3.1-generate-001', { instances: [{ prompt: 'x' }], parameters: { sampleCount: 5 } }, 't')).rejects.toThrow(/sampleCount/);
    expect(post).not.toHaveBeenCalled();
  });
});
