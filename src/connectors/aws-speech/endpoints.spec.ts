import { describe, expect, it } from 'vitest';
import { resolveAwsSpeechEndpoints, type AwsPartition } from './endpoints';

describe('resolveAwsSpeechEndpoints', () => {
  it.each([
    [
      'aws',
      'us-west-2',
      'https://transcribe.us-west-2.amazonaws.com/transcribe',
      'https://transcribestreaming.us-west-2.amazonaws.com/stream-transcription',
      'wss://transcribestreaming.us-west-2.amazonaws.com:8443/stream-transcription-websocket',
      'https://polly.us-west-2.amazonaws.com',
    ],
    [
      'aws-us-gov',
      'us-gov-west-1',
      'https://transcribe.us-gov-west-1.amazonaws.com/transcribe',
      'https://transcribestreaming.us-gov-west-1.amazonaws.com/stream-transcription',
      'wss://transcribestreaming.us-gov-west-1.amazonaws.com:8443/stream-transcription-websocket',
      'https://polly.us-gov-west-1.amazonaws.com',
    ],
    [
      'aws-cn',
      'cn-north-1',
      'https://transcribe.cn-north-1.amazonaws.com.cn/transcribe',
      'https://transcribestreaming.cn-north-1.amazonaws.com.cn/stream-transcription',
      'wss://transcribestreaming.cn-north-1.amazonaws.com.cn:8443/stream-transcription-websocket',
      'https://polly.cn-north-1.amazonaws.com.cn',
    ],
  ])(
    'resolves the %s partition without asserting service availability',
    (partition, region, batch, stream, websocket, polly) => {
      expect(
        resolveAwsSpeechEndpoints({
          partition: partition as AwsPartition,
          region,
        }),
      ).toEqual({
        transcribeBatch: batch,
        transcribeStreaming: stream,
        transcribeWebSocket: websocket,
        polly,
      });
    },
  );

  it('accepts an explicit custom AWS partition descriptor', () => {
    expect(
      resolveAwsSpeechEndpoints({
        partition: { id: 'aws-custom', dnsSuffix: 'example.aws' },
        region: 'custom-1',
      }),
    ).toEqual({
      transcribeBatch: 'https://transcribe.custom-1.example.aws/transcribe',
      transcribeStreaming: 'https://transcribestreaming.custom-1.example.aws/stream-transcription',
      transcribeWebSocket:
        'wss://transcribestreaming.custom-1.example.aws:8443/stream-transcription-websocket',
      polly: 'https://polly.custom-1.example.aws',
    });
  });

  it('rejects unsafe region and DNS suffix input', () => {
    expect(() => resolveAwsSpeechEndpoints({ partition: 'aws', region: 'us-west-2/path' })).toThrow(
      'region',
    );
    expect(() =>
      resolveAwsSpeechEndpoints({
        partition: { id: 'custom', dnsSuffix: 'https://bad.example' },
        region: 'custom-1',
      }),
    ).toThrow('dnsSuffix');
  });
});
