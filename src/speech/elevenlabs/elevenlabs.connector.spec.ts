import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsConnector } from './elevenlabs.connector';

describe('ElevenLabsConnector', () => {
  const fetcher = vi.fn<typeof fetch>();
  let connector: ElevenLabsConnector;

  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = 'fixture-key';
    fetcher.mockReset();
    connector = ElevenLabsConnector.withFetch(fetcher);
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_API_KEY;
  });

  it('sends synchronous TTS JSON and returns binary response metadata', async () => {
    fetcher.mockResolvedValue(
      new Response('audio', {
        headers: {
          'content-type': 'audio/mpeg',
          'request-id': 'req-tts',
          'character-cost': '5',
        },
      }),
    );

    const result = await connector.textToSpeech({
      voiceId: 'voice/1',
      text: 'Hello',
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'mp3_44100_128',
    });
    const [url, init] = fetcher.mock.calls[0];

    expect(String(url)).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128',
    );
    expect(init?.headers).toMatchObject({
      'xi-api-key': 'fixture-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'Hello',
      model_id: 'eleven_multilingual_v2',
    });
    expect(result).toMatchObject({
      contentType: 'audio/mpeg',
      requestId: 'req-tts',
      characterCost: 5,
    });
  });

  it('uses the streaming TTS resource when streaming is requested', async () => {
    const response = new Response('chunk');
    vi.spyOn(response, 'clone').mockImplementation(() => {
      throw new Error('streaming responses must not be buffered');
    });
    fetcher.mockResolvedValue(response);

    const result = await connector.textToSpeech({ voiceId: 'voice', text: 'Hello' }, true);

    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice/stream',
    );
    expect(result.data).toBeNull();
    expect(result.stream).toBe(response.body);
  });

  it('builds multipart speech-to-speech input and selects its stream resource', async () => {
    fetcher.mockResolvedValue(new Response('audio'));

    await connector.speechToSpeech(
      {
        voiceId: 'target',
        audio: new Blob(['wav']),
        modelId: 'eleven_multilingual_sts_v2',
        removeBackgroundNoise: true,
      },
      true,
    );
    const [url, init] = fetcher.mock.calls[0];
    const form = init?.body as FormData;

    expect(String(url)).toBe('https://api.elevenlabs.io/v1/speech-to-speech/target/stream');
    expect(form.get('audio')).toBeInstanceOf(Blob);
    expect(form.get('model_id')).toBe('eleven_multilingual_sts_v2');
    expect(form.get('remove_background_noise')).toBe('true');
  });

  it('builds multipart STT input and parses the transcript response', async () => {
    fetcher.mockResolvedValue(Response.json({ text: 'fixture transcript', language_code: 'en' }));

    const result = await connector.speechToText({
      file: new Blob(['audio']),
      modelId: 'scribe_v2',
      diarize: true,
    });
    const form = fetcher.mock.calls[0][1]?.body as FormData;

    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('diarize')).toBe('true');
    expect(result).toEqual({ text: 'fixture transcript', language_code: 'en' });
  });

  it('covers dubbing create, status, list, audio, transcript, and delete resources', async () => {
    fetcher
      .mockResolvedValueOnce(Response.json({ dubbing_id: 'dub-1' }))
      .mockResolvedValueOnce(Response.json({ dubbing_id: 'dub-1', status: 'dubbing' }))
      .mockResolvedValueOnce(Response.json({ dubs: [], has_more: false }))
      .mockResolvedValueOnce(new Response('audio'))
      .mockResolvedValueOnce(Response.json({ transcript_format: 'srt', srt: 'fixture' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await connector.createDubbing({
      file: new Blob(['video']),
      targetLanguage: 'es',
    });
    await connector.getDubbing('dub-1');
    await connector.listDubbings({ cursor: 'next', pageSize: 10 });
    await connector.getDubbedAudio('dub-1', 'es');
    await connector.getDubbingTranscript('dub-1', 'es', 'srt');
    await connector.deleteDubbing('dub-1');

    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      ['https://api.elevenlabs.io/v1/dubbing', 'POST'],
      ['https://api.elevenlabs.io/v1/dubbing/dub-1', 'GET'],
      ['https://api.elevenlabs.io/v1/dubbing?cursor=next&page_size=10', 'GET'],
      ['https://api.elevenlabs.io/v1/dubbing/dub-1/audio/es', 'GET'],
      ['https://api.elevenlabs.io/v1/dubbing/dub-1/transcripts/es/format/srt', 'GET'],
      ['https://api.elevenlabs.io/v1/dubbing/dub-1', 'DELETE'],
    ]);
  });

  it('uses voice discovery resources and preserves pagination parameters', async () => {
    fetcher.mockResolvedValue(Response.json({ voices: [], has_more: false }));

    await connector.listVoices({ nextPageToken: 'token', pageSize: 20, search: 'calm' });
    await connector.getVoice('voice-1');
    await connector.listSharedVoices({ page: 2, pageSize: 30, language: 'en' });

    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.elevenlabs.io/v2/voices?next_page_token=token&page_size=20&search=calm',
      'https://api.elevenlabs.io/v1/voices/voice-1',
      'https://api.elevenlabs.io/v1/shared-voices?page=2&page_size=30&language=en',
    ]);
  });

  it('projects provider error status, code, request id, and retry metadata', async () => {
    fetcher.mockResolvedValue(
      Response.json(
        { detail: { status: 'quota_exceeded', message: 'Quota exceeded' } },
        {
          status: 429,
          headers: {
            'request-id': 'req-429',
            'x-trace-id': 'trace-429',
            'retry-after': '3',
          },
        },
      ),
    );

    await expect(connector.getVoice('voice')).rejects.toMatchObject({
      status: 429,
      code: 'quota_exceeded',
      message: 'Quota exceeded',
      requestId: 'req-429',
      traceId: 'trace-429',
      retryAfter: '3',
    });
  });

  it('fails authentication before network access when credentials are absent', async () => {
    delete process.env.ELEVENLABS_API_KEY;

    await expect(connector.getVoice('voice')).rejects.toMatchObject({
      status: 503,
      code: 'not_configured',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
