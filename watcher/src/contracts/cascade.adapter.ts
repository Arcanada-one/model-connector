import { DependencyUnavailableError } from '../types.js';

export class CascadeAdapter {
  readonly contractVersion = null;

  isAvailable(): boolean {
    return false;
  }

  async proposeFailover(_input: unknown): Promise<never> {
    throw new DependencyUnavailableError('CONN-0223');
  }
}
