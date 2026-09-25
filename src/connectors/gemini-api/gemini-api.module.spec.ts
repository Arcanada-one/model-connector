import { describe, expect, it, vi } from 'vitest';
import { GeminiApiConnector } from './gemini-api.connector';
import { GeminiApiModule } from './gemini-api.module';

describe('GeminiApiModule', () => {
  it('preserves the immutable gemini-api registration identity', () => {
    const connector = new GeminiApiConnector();
    // refreshModels(): Promise<CatalogRefreshResult> (base-api.connector.ts:337)
    const refresh = vi.spyOn(connector, 'refreshModels').mockResolvedValue({
      status: 'success',
      source: 'provider-api',
      observedAt: new Date('2026-09-25T00:00:00Z'),
    });
    const connectors = { register: vi.fn() };
    const module = new GeminiApiModule(connector, connectors as never);

    module.onModuleInit();

    expect(connectors.register).toHaveBeenCalledWith(connector);
    expect(refresh).toHaveBeenCalledOnce();
    expect(connector.name).toBe('gemini-api');
  });
});
