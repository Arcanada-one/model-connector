import { describe, expect, it, vi } from 'vitest';
import { GeminiApiConnector } from './gemini-api.connector';
import { GeminiApiModule } from './gemini-api.module';

describe('GeminiApiModule', () => {
  it('preserves the immutable gemini-api registration identity', () => {
    const connector = new GeminiApiConnector();
    const refresh = vi.spyOn(connector, 'refreshModels').mockResolvedValue();
    const connectors = { register: vi.fn() };
    const module = new GeminiApiModule(connector, connectors as never);

    module.onModuleInit();

    expect(connectors.register).toHaveBeenCalledWith(connector);
    expect(refresh).toHaveBeenCalledOnce();
    expect(connector.name).toBe('gemini-api');
  });
});
