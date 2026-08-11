import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { AzureSpeechConnector } from './azure-speech.connector';
import { AzureSpeechModule } from './azure-speech.module';
import type { AzureSpeechHttpTransport, AzureSpeechStreamingTransport } from './types';

describe('AzureSpeechModule', () => {
  it('registers one explicit connector from injected transports without network I/O', async () => {
    const httpTransport = vi.fn<AzureSpeechHttpTransport>();
    const streamingTransport: AzureSpeechStreamingTransport = {
      connect: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: 'recognized', text: 'offline' } as const;
        },
      })),
    };

    const testingModule = await Test.createTestingModule({
      imports: [
        AzureSpeechModule.forRoot({
          deployment: { kind: 'public-region', region: 'eastus' },
          authentication: {
            kind: 'resource-key',
            key: 'offline-resource-key',
          },
          httpTransport,
          streamingTransport,
          delay: async () => undefined,
        }),
      ],
    }).compile();

    expect(testingModule.get(AzureSpeechConnector)).toBeInstanceOf(AzureSpeechConnector);
    expect(httpTransport).not.toHaveBeenCalled();
  });
});
