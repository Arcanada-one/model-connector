import { describe, expect, it, vi } from 'vitest';
import { NovaMediaConnector } from './nova-media.connector';
import { NovaMediaModule } from './nova-media.module';

describe('NovaMediaModule', () => {
  it('registers only the additive Nova media connector and makes no request', () => {
    const connector = new NovaMediaConnector();
    const registry = { register: vi.fn() };
    const module = new NovaMediaModule(connector, registry);

    module.onModuleInit();

    expect(registry.register).toHaveBeenCalledOnce();
    expect(registry.register).toHaveBeenCalledWith(connector);
  });
});
