/**
 * The three connectors priced on 2026-11-04 expose the official list prices (sources are cited in each
 * connector). A change of these numbers must be a deliberate edit of both the table and this spec.
 */
import { describe, expect, it } from 'vitest';
import { FireworksConnector } from '../connectors/fireworks/fireworks.connector';
import { GeminiApiConnector } from '../connectors/gemini-api/gemini-api.connector';
import { CloudflareWorkersAiConnector } from '../connectors/cloudflare-workers-ai/cloudflare-workers-ai.connector';

function priceOf(meta: { id: string; pricing?: { inputPerMTok: number | null; outputPerMTok: number | null } | null }[], id: string) {
  const m = meta.find((x) => x.id === id);
  return m?.pricing ? [m.pricing.inputPerMTok, m.pricing.outputPerMTok] : null;
}

describe('official prices retrieved 2026-11-04', () => {
  it('fireworks llama-v3p1-8b-instruct: 4B-16B band, one rate for input and output', () => {
    const meta = new FireworksConnector().getCapabilities().modelMeta ?? [];
    expect(priceOf(meta, 'accounts/fireworks/models/llama-v3p1-8b-instruct')).toEqual([0.2, 0.2]);
  });

  it('gemini-2.5-flash is priced; gemini-2.5-pro stays unpriced (tiered by prompt size)', () => {
    const meta = new GeminiApiConnector().getCapabilities().modelMeta ?? [];
    expect(priceOf(meta, 'gemini-2.5-flash')).toEqual([0.3, 2.5]);
    expect(priceOf(meta, 'gemini-2.5-pro')).toBeNull();
  });

  it('cloudflare workers-ai text models carry the published per-token prices', () => {
    const meta = new CloudflareWorkersAiConnector().getCapabilities().modelMeta ?? [];
    expect(priceOf(meta, '@cf/meta/llama-3.1-8b-instruct')).toEqual([0.282, 0.827]);
    expect(priceOf(meta, '@cf/meta/llama-3.2-3b-instruct')).toEqual([0.051, 0.335]);
    expect(priceOf(meta, '@cf/qwen/qwen2.5-coder-32b-instruct')).toEqual([0.66, 1.0]);
  });
});
