import { describe, it, expect } from 'vitest';
import {
  SttProviderError,
  SttAllProvidersExhausted,
  SttAudioTooLargeError,
  SttUnsupportedMimeError,
} from './stt-pilot.errors';

describe('STT pilot errors', () => {
  it('SttProviderError carries provider/type/upstream fields', () => {
    const err = new SttProviderError('groq', 'auth_failed', 'bad key', 'invalid_api_key', 401);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SttProviderError');
    expect(err.provider).toBe('groq');
    expect(err.type).toBe('auth_failed');
    expect(err.upstreamCode).toBe('invalid_api_key');
    expect(err.upstreamStatus).toBe(401);
    expect(err.message).toBe('bad key');
  });

  it('SttAllProvidersExhausted enumerates tried providers and may carry lastError', () => {
    const last = new SttProviderError('groq', 'server_error', 'boom');
    const err = new SttAllProvidersExhausted(['groq'], last);
    expect(err.name).toBe('SttAllProvidersExhausted');
    expect(err.providersTried).toEqual(['groq']);
    expect(err.lastError).toBe(last);
    expect(err.message).toContain('groq');
  });

  it('SttAudioTooLargeError reports received vs allowed size', () => {
    const err = new SttAudioTooLargeError(40_000_000, 25 * 1024 * 1024);
    expect(err.name).toBe('SttAudioTooLargeError');
    expect(err.receivedBytes).toBe(40_000_000);
    expect(err.maxBytes).toBe(26_214_400);
    expect(err.message).toContain('40000000');
  });

  it('SttUnsupportedMimeError lists allowed types in message', () => {
    const err = new SttUnsupportedMimeError('image/png', ['audio/wav', 'audio/mpeg']);
    expect(err.name).toBe('SttUnsupportedMimeError');
    expect(err.mimeType).toBe('image/png');
    expect(err.allowed).toEqual(['audio/wav', 'audio/mpeg']);
    expect(err.message).toContain('audio/wav');
  });

  it('all errors are catchable as Error', () => {
    const candidates: Error[] = [
      new SttProviderError('groq', 'timeout', 't'),
      new SttAllProvidersExhausted(['groq']),
      new SttAudioTooLargeError(1, 0),
      new SttUnsupportedMimeError('x', []),
    ];
    for (const err of candidates) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});
