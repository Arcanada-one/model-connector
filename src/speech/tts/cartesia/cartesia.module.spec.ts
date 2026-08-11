import { describe, expect, it } from 'vitest';
import { CartesiaModule } from './cartesia.module';

describe('CartesiaModule', () => {
  it('exports the AU-006 Cartesia native voice/TTS module', () => {
    expect(CartesiaModule).toBeDefined();
  });
});
