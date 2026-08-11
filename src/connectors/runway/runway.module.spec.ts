import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { RunwayConnector } from './runway.connector';
import { RunwayModule } from './runway.module';
import type { RunwayHttpTransport } from './runway.types';

describe('RunwayModule', () => {
  it('injects caller-owned transport, key, and origin', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { id: 'task-id' } });
    const transport: RunwayHttpTransport = { request };
    const module = await Test.createTestingModule({
      imports: [
        RunwayModule.register({
          apiKey: 'module-key',
          transport,
          origin: 'https://runway-proxy.internal/',
        }),
      ],
    }).compile();

    await module.get(RunwayConnector).textToVideo({ model: 'gen4.5' });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://runway-proxy.internal/v1/text_to_video',
        headers: expect.objectContaining({ Authorization: 'Bearer module-key' }),
      }),
    );
    await module.close();
  });
});
