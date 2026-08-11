import { describe, expect, it, vi } from 'vitest';
import { DeepgramAuraStream, DeepgramTtsStreamError } from './deepgram-tts.stream';
import type { DeepgramWebSocket } from './deepgram-tts.types';

function socketHarness() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const socket: DeepgramWebSocket = {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    }),
  };
  return {
    socket,
    emit: (name: string, event: unknown) => listeners.get(name)?.forEach((fn) => fn(event)),
  };
}

describe('DeepgramAuraStream', () => {
  it('connects with documented URL and API-key subprotocol then sends lifecycle messages', () => {
    const { socket } = socketHarness();
    const factory = vi.fn(() => socket);
    const stream = new DeepgramAuraStream({ factory });
    const session = stream.connect({
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      auth: { type: 'api-key', credential: 'dg-key' },
    });
    expect(factory).toHaveBeenCalledWith(
      'wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16',
      ['token', 'dg-key'],
    );
    session.speak('Hello');
    session.flush();
    session.clear();
    session.finish();
    expect(socket.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ type: 'Speak', text: 'Hello' }),
    );
    expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({ type: 'Flush' }));
    expect(socket.send).toHaveBeenNthCalledWith(3, JSON.stringify({ type: 'Clear' }));
    expect(socket.send).toHaveBeenNthCalledWith(4, JSON.stringify({ type: 'Close' }));
  });

  it('uses bearer subprotocol for temporary JWT authentication', () => {
    const { socket } = socketHarness();
    const factory = vi.fn(() => socket);
    new DeepgramAuraStream({ factory }).connect({
      model: 'aura-2-thalia-en',
      auth: { type: 'bearer', credential: 'jwt' },
    });
    expect(factory).toHaveBeenCalledWith(expect.any(String), ['bearer', 'jwt']);
  });

  it('emits binary audio and documented server events', () => {
    const { socket, emit } = socketHarness();
    const events: unknown[] = [];
    const session = new DeepgramAuraStream({ factory: () => socket }).connect({
      model: 'aura-2-thalia-en',
      auth: { type: 'api-key', credential: 'k' },
    });
    session.onEvent((event) => events.push(event));
    emit('message', { data: Uint8Array.from([4, 5]).buffer });
    for (const type of ['Metadata', 'Flushed', 'Cleared', 'Warning'])
      emit('message', { data: JSON.stringify({ type, request_id: 'r1' }) });
    expect(events).toEqual([
      { type: 'Audio', audio: Uint8Array.from([4, 5]) },
      { type: 'Metadata', request_id: 'r1' },
      { type: 'Flushed', request_id: 'r1' },
      { type: 'Cleared', request_id: 'r1' },
      { type: 'Warning', request_id: 'r1' },
    ]);
  });

  it('accepts normal close and propagates abnormal close without leaking credentials', () => {
    const { socket, emit } = socketHarness();
    const errors: Error[] = [];
    const session = new DeepgramAuraStream({ factory: () => socket }).connect({
      model: 'aura-2-thalia-en',
      auth: { type: 'api-key', credential: 'secret' },
    });
    session.onError((error) => errors.push(error));
    emit('close', { code: 1000, reason: 'done' });
    expect(errors).toEqual([]);
    emit('close', { code: 1011, reason: 'upstream failed' });
    expect(errors[0]).toBeInstanceOf(DeepgramTtsStreamError);
    expect(errors[0].message).toContain('1011');
    expect(errors[0].message).not.toContain('secret');
  });

  it('rejects empty Speak text before transport', () => {
    const { socket } = socketHarness();
    const session = new DeepgramAuraStream({ factory: () => socket }).connect({
      model: 'aura-2-thalia-en',
      auth: { type: 'api-key', credential: 'k' },
    });
    expect(() => session.speak('')).toThrow(/text/i);
    expect(socket.send).not.toHaveBeenCalled();
  });
});
