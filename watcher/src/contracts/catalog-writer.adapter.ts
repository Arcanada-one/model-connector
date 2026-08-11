import { DependencyUnavailableError } from '../types.js';

export class DisabledCatalogWriterAdapter {
  readonly contractVersion = null;

  isAvailable(): boolean {
    return false;
  }

  async submitValidatedDiff(_input: unknown): Promise<never> {
    throw new DependencyUnavailableError('CONN-0226');
  }
}
