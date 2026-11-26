/**
 * Integration tests for OpenAI GPT Image 2.5 Sunburst.
 * Gate: RUN_INTEGRATION=1 AND OPENAI_INTEGRATION=1.
 * These tests make three billable image-generation calls when explicitly enabled.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { OpenAIImagesConnector } from './openai-images.connector';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';

const shouldRun = process.env.RUN_INTEGRATION === '1';
const openaiEnabled = process.env.OPENAI_INTEGRATION === '1';

function makeConnector(name: string): OpenAIImagesConnector {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
    throw new Error('OPENAI_API_KEY must be provided to run OpenAI image integration tests');
  }
  return new OpenAIImagesConnector(apiKey, new CircuitBreakerManager(name, 5, 60_000));
}

describe.skipIf(!shouldRun || !openaiEnabled)('OpenAI GPT Image 2.5 Sunburst [INTEGRATION]', () => {
  let connector: OpenAIImagesConnector;

  beforeAll(() => {
    connector = makeConnector('openai-image-integration');
  });

  it('generates a low-quality image and reports the returned usage cost', async () => {
    const result = await connector.generate({
      tier: 'cheap',
      prompt: 'a single green cube on plain white background, minimalist product photo',
      quality: 'low',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'never',
    });

    expect(result.status).toBe('completed');
    expect(result.urls?.[0]).toMatch(/^data:image\/png;base64,/);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.routing.chosenModel).toBe('openai:gpt-image-2.5-sunburst-low');
  }, 60_000);

  it('returns a request UUID for a generated image', async () => {
    const result = await connector.generate({
      tier: 'cheap',
      prompt: 'a simple red sphere on white background',
      quality: 'low',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'never',
    });

    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.urls?.[0]).toMatch(/^data:image\/png;base64,/);
  }, 60_000);

  it('generates a medium-quality image without assuming fixed per-image pricing', async () => {
    const result = await connector.generate({
      tier: 'mid',
      prompt: 'a single blue sphere on plain white background, minimalist product photo',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'never',
    });

    expect(result.status).toBe('completed');
    expect(result.urls?.[0]).toMatch(/^data:image\/png;base64,/);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.routing.chosenModel).toBe('openai:gpt-image-2.5-sunburst-medium');
  }, 60_000);
});
