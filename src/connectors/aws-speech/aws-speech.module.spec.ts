import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { AwsSpeechConnector } from './aws-speech.connector';
import { AwsSpeechModule } from './aws-speech.module';

describe('AwsSpeechModule', () => {
  it('requires and exports caller-injected signer and transports', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AwsSpeechModule.forRoot({
          region: 'us-west-2',
          partition: 'aws',
          signer: {
            signHttp: vi.fn(),
            presignWebSocket: vi.fn(),
            signEventFrame: vi.fn(),
          },
          httpTransport: { send: vi.fn() },
          eventStreamTransport: { stream: vi.fn() },
        }),
      ],
    }).compile();

    expect(moduleRef.get(AwsSpeechConnector)).toBeInstanceOf(AwsSpeechConnector);
  });
});
