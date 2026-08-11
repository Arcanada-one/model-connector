import { describe, expect, it } from 'vitest';
import { AwsSpeechServiceError, parseAwsEventStreamError, parseAwsHttpError } from './errors';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('AWS Speech errors', () => {
  it('preserves throttling details and marks the failure retryable', () => {
    const error = parseAwsHttpError('polly', 'SynthesizeSpeech', {
      statusCode: 429,
      headers: {
        'x-amzn-errortype': 'ThrottlingException',
        'x-amzn-requestid': 'req-throttle',
      },
      body: bytes({ __type: 'ThrottlingException', message: 'Rate exceeded' }),
    });

    expect(error).toBeInstanceOf(AwsSpeechServiceError);
    expect(error).toMatchObject({
      service: 'polly',
      operation: 'SynthesizeSpeech',
      providerCode: 'ThrottlingException',
      statusCode: 429,
      requestId: 'req-throttle',
      retryable: true,
      message: 'Rate exceeded',
    });
  });

  it('keeps authentication failures non-retryable', () => {
    expect(
      parseAwsHttpError('transcribe', 'GetTranscriptionJob', {
        statusCode: 403,
        headers: {
          'x-amzn-errortype': 'UnrecognizedClientException',
          'x-amzn-requestid': 'req-auth',
        },
        body: bytes({
          __type: 'UnrecognizedClientException',
          Message: 'Invalid signature',
        }),
      }),
    ).toMatchObject({
      providerCode: 'UnrecognizedClientException',
      requestId: 'req-auth',
      retryable: false,
      message: 'Invalid signature',
    });
  });

  it('normalizes event-stream exception events with the same shape', () => {
    expect(
      parseAwsEventStreamError({
        type: 'exception',
        code: 'LimitExceededException',
        message: 'Concurrent stream limit exceeded',
        requestId: 'req-stream-limit',
      }),
    ).toMatchObject({
      service: 'transcribe',
      operation: 'StartStreamTranscription',
      providerCode: 'LimitExceededException',
      statusCode: 429,
      requestId: 'req-stream-limit',
      retryable: true,
    });
  });
});
