import { describe, it, expect, vi, afterEach } from 'vitest';
import { ImageGenerationModule } from './image-generation.module';
import * as capabilitiesModule from './capabilities';

/**
 * C1: validateCapabilities() MUST be auto-invoked at module bootstrap.
 * If capabilities data is broken, the module must throw (fail-fast).
 */
describe('ImageGenerationModule — C1 fail-fast bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls validateCapabilities() during onApplicationBootstrap', () => {
    const spy = vi.spyOn(capabilitiesModule, 'validateCapabilities').mockImplementation(() => {});
    const module = new ImageGenerationModule();
    module.onApplicationBootstrap();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('throws if validateCapabilities() throws (fail-fast on broken capability data)', () => {
    vi.spyOn(capabilitiesModule, 'validateCapabilities').mockImplementation(() => {
      throw new Error('capability validation failed');
    });
    const module = new ImageGenerationModule();
    expect(() => module.onApplicationBootstrap()).toThrow('capability validation failed');
  });
});
