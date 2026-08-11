import { describe, expect, it, vi } from 'vitest';
import { DeepgramVoiceAgentClient, buildDeepgramVoiceAgentAuth } from './deepgram-voice-agent.client';
import { DEEPGRAM_VOICE_AGENT_CAPABILITIES } from './deepgram-voice-agent.capabilities';
import { SERVER_MESSAGES, SETTINGS } from './deepgram-voice-agent.fixtures';

class FakeSocket {
  readonly sent: Array<string | Uint8Array> = [];
  close = vi.fn();
  send(data: string | Uint8Array) { this.sent.push(data); }
}

describe('DeepgramVoiceAgentClient', () => {
  it('constructs each documented authentication form without exposing a secret elsewhere', () => {
    expect(buildDeepgramVoiceAgentAuth({ type: 'token', credential: 'key' })).toEqual({ authorization: 'Token key' });
    expect(buildDeepgramVoiceAgentAuth({ type: 'bearer', credential: 'jwt' })).toEqual({ authorization: 'Bearer jwt' });
    expect(buildDeepgramVoiceAgentAuth({ type: 'subprotocol', credential: 'key' })).toEqual({ protocols: ['token', 'key'] });
  });

  it('waits for Welcome, sends Settings, then waits for SettingsApplied', () => {
    const socket = new FakeSocket();
    const client = new DeepgramVoiceAgentClient(socket, SETTINGS);
    expect(() => client.sendAudio(new Uint8Array([1]))).toThrow(/SettingsApplied/);
    client.receive(JSON.stringify({ type: 'Welcome', request_id: 'request-1' }));
    expect(socket.sent).toEqual([JSON.stringify(SETTINGS)]);
    expect(() => client.injectUserMessage('early')).toThrow(/SettingsApplied/);
    client.receive(JSON.stringify({ type: 'SettingsApplied' }));
    client.sendAudio(new Uint8Array([1, 2]));
    client.injectUserMessage('Hello');
    expect(socket.sent.slice(1)).toEqual([
      new Uint8Array([1, 2]),
      JSON.stringify({ type: 'InjectUserMessage', content: 'Hello' }),
    ]);
  });

  it('serializes every documented post-settings client lifecycle message family', () => {
    const socket = new FakeSocket();
    const client = new DeepgramVoiceAgentClient(socket, SETTINGS);
    client.receive(JSON.stringify({ type: 'Welcome', request_id: 'r' }));
    client.receive(JSON.stringify({ type: 'SettingsApplied' }));
    client.send({ type: 'UpdateListen', listen: { provider: { type: 'deepgram', model: 'nova-3' } } });
    client.send({ type: 'UpdateThink', think: { provider: { type: 'open_ai', model: 'gpt-4o-mini' } } });
    client.send({ type: 'UpdateSpeak', speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } } });
    client.send({ type: 'UpdatePrompt', prompt: 'Be concise.' });
    client.send({ type: 'InjectAgentMessage', message: 'Welcome', behavior: 'queue' });
    client.send({ type: 'FunctionCallResponse', id: 'call-1', name: 'lookup', content: 'ok' });
    client.send({ type: 'KeepAlive' });
    expect(socket.sent).toHaveLength(8);
  });

  it.each(SERVER_MESSAGES)('emits documented server message $type', (message) => {
    const client = new DeepgramVoiceAgentClient(new FakeSocket(), SETTINGS);
    const observed = vi.fn();
    client.onMessage(observed);
    client.receive(JSON.stringify(message));
    expect(observed).toHaveBeenCalledWith(message);
  });

  it('passes server binary audio through and treats Warning as non-fatal', () => {
    const socket = new FakeSocket();
    const client = new DeepgramVoiceAgentClient(socket, SETTINGS);
    const observed = vi.fn();
    client.onMessage(observed);
    const audio = new Uint8Array([3, 4]);
    client.receive(audio);
    client.receive(JSON.stringify({ type: 'Warning', code: 'SLOW_SPEAK_REQUEST', description: 'slow' }));
    expect(observed).toHaveBeenNthCalledWith(1, audio);
    expect(client.state).not.toBe('failed');
  });

  it('makes Error terminal and closes the socket', () => {
    const socket = new FakeSocket();
    const client = new DeepgramVoiceAgentClient(socket, SETTINGS);
    client.receive(JSON.stringify({ type: 'Error', code: 'INVALID_SETTINGS', description: 'bad' }));
    expect(client.state).toBe('failed');
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('publishes narrow capability metadata', () => {
    expect(DEEPGRAM_VOICE_AGENT_CAPABILITIES.endpoint).toBe('wss://agent.deepgram.com/v1/agent/converse');
    expect(DEEPGRAM_VOICE_AGENT_CAPABILITIES.authentication).toEqual(['token', 'bearer', 'sec-websocket-protocol']);
    expect(DEEPGRAM_VOICE_AGENT_CAPABILITIES.modalities).toEqual(['audio-input', 'audio-output', 'text']);
    expect(DEEPGRAM_VOICE_AGENT_CAPABILITIES).not.toHaveProperty('models');
  });
});
