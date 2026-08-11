import { describe, expect, it, vi } from 'vitest';
import { HumeEviConnector, HUME_EVI_CAPABILITIES } from './hume-evi.connector';
import type { HumeHttpTransport, HumeSocket } from './hume-evi.types';

const http: HumeHttpTransport = vi.fn(async (request) => ({
  status: 200,
  body: { request },
}));

function connector() {
  return new HumeEviConnector({ httpTransport: http });
}

describe('HumeEviConnector AU-007', () => {
  it('constructs config CRUD requests with native bodies', async () => {
    const client = connector();
    await client.createConfig({ apiKey: 'secret' }, { evi_version: '3', name: 'weather' });
    await client.listConfigs({ accessToken: 'token' }, { pageNumber: 0, pageSize: 10 });
    await client.getConfig({ apiKey: 'secret' }, 'config/id', 2);
    await client.updateConfig({ apiKey: 'secret' }, 'config/id', { name: 'updated' });
    await client.deleteConfig({ apiKey: 'secret' }, 'config/id');

    expect(vi.mocked(http).mock.calls.map(([r]) => [r.method, r.url])).toEqual([
      ['POST', 'https://api.hume.ai/v0/evi/configs'],
      ['GET', 'https://api.hume.ai/v0/evi/configs?page_number=0&page_size=10'],
      ['GET', 'https://api.hume.ai/v0/evi/configs/config%2Fid?version=2'],
      ['POST', 'https://api.hume.ai/v0/evi/configs/config%2Fid'],
      ['DELETE', 'https://api.hume.ai/v0/evi/configs/config%2Fid'],
    ]);
    expect(vi.mocked(http).mock.calls[0][0].body).toEqual({
      evi_version: '3',
      name: 'weather',
    });
    expect(vi.mocked(http).mock.calls[0][0].headers).toEqual({
      'Content-Type': 'application/json',
      'X-Hume-Api-Key': 'secret',
    });
    expect(vi.mocked(http).mock.calls[1][0].headers).toEqual({
      Authorization: 'Bearer token',
    });
  });

  it('serializes provider history pagination and encodes identifiers', async () => {
    const client = connector();
    await client.listChats(
      { apiKey: 'key' },
      { pageNumber: 0, pageSize: 100, ascendingOrder: false },
    );
    await client.listChatGroups({ apiKey: 'key' }, { pageNumber: 2 });
    await client.listChatGroupEvents({ apiKey: 'key' }, 'group/id', {
      pageSize: 3,
      ascendingOrder: true,
    });
    expect(
      vi
        .mocked(http)
        .mock.calls.slice(-3)
        .map(([r]) => r.url),
    ).toEqual([
      'https://api.hume.ai/v0/evi/chats?page_number=0&page_size=100&ascending_order=false',
      'https://api.hume.ai/v0/evi/chat_groups?page_number=2',
      'https://api.hume.ai/v0/evi/chat_groups/group%2Fid/events?page_size=3&ascending_order=true',
    ]);
  });

  it('builds authenticated WebSocket URLs with documented session controls', () => {
    expect(
      connector().buildChatUrl(
        { accessToken: 'access token' },
        {
          configId: 'cfg',
          configVersion: 4,
          resumedChatGroupId: 'group',
          verboseTranscription: true,
          allowConnection: false,
        },
      ),
    ).toBe(
      'wss://api.hume.ai/v0/evi/chat?access_token=access+token&config_id=cfg&config_version=4&resumed_chat_group_id=group&verbose_transcription=true&allow_connection=false',
    );
  });

  it('passes native frames and signals interruption without executing tools', () => {
    const frames: unknown[] = [];
    const stops: unknown[] = [];
    const client = connector();
    const toolFrame = { type: 'tool_call', tool_call_id: '1', name: 'weather', parameters: '{}' };
    client.handleFrame(toolFrame, {
      onFrame: (frame) => frames.push(frame),
      onStopPlayback: (frame) => stops.push(frame),
    });
    client.handleFrame(
      { type: 'user_interruption' },
      { onFrame: (frame) => frames.push(frame), onStopPlayback: (frame) => stops.push(frame) },
    );
    client.handleFrame(
      { type: 'user_message', interim: true },
      {
        verboseTranscription: true,
        onFrame: (frame) => frames.push(frame),
        onStopPlayback: (frame) => stops.push(frame),
      },
    );
    expect(frames[0]).toBe(toolFrame);
    expect(stops).toHaveLength(2);
  });

  it('sends base64 audio unchanged through an injected socket', () => {
    const send = vi.fn();
    const socket = { send } as unknown as HumeSocket;
    connector().sendAudio(socket, 'AAECAw==');
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'audio_input', data: 'AAECAw==' }));
  });

  it('preserves HTTP and WebSocket provider errors', async () => {
    const body = { code: 'E123', message: 'provider failure' };
    const failing = new HumeEviConnector({
      httpTransport: vi.fn(async () => ({ status: 400, body })),
    });
    expect(await failing.listChats({ apiKey: 'key' })).toEqual({ status: 400, body });
    const frame = { type: 'error', code: 'I0118', slug: 'transcription_disconnected' };
    const onFrame = vi.fn();
    failing.handleFrame(frame, { onFrame });
    expect(onFrame).toHaveBeenCalledWith(frame);
  });

  it('rejects ambiguous/missing auth without exposing supplied secrets', () => {
    expect(() => connector().buildChatUrl({})).toThrow('exactly one authentication mode');
    expect(() =>
      connector().buildChatUrl({ apiKey: 'api-secret', accessToken: 'token-secret' }),
    ).toThrow('exactly one authentication mode');
    try {
      connector().buildChatUrl({ apiKey: 'api-secret', accessToken: 'token-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('api-secret');
      expect(String(error)).not.toContain('token-secret');
    }
  });

  it('declares only documented global hosts and no region claims', () => {
    expect(HUME_EVI_CAPABILITIES).toEqual({
      provider: 'hume-evi',
      restBaseUrl: 'https://api.hume.ai',
      websocketUrl: 'wss://api.hume.ai/v0/evi/chat',
      realtimeSpeechToSpeech: true,
      supportingRest: ['configs', 'chats', 'chat_groups', 'chat_group_events'],
    });
    expect(JSON.stringify(HUME_EVI_CAPABILITIES)).not.toMatch(/region|residen/i);
  });
});
