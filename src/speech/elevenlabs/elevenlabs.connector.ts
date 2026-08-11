import { Injectable } from '@nestjs/common';
import { ElevenLabsError } from './elevenlabs.error';
import type {
  BinaryResponse,
  DubbingCreateRequest,
  QueryValueMap,
  SpeechToSpeechRequest,
  SpeechToTextRequest,
  TextToSpeechRequest,
} from './elevenlabs.types';

const API_BASE = 'https://api.elevenlabs.io';

@Injectable()
export class ElevenLabsConnector {
  private fetcher: typeof fetch = globalThis.fetch;

  static withFetch(fetcher: typeof fetch): ElevenLabsConnector {
    const connector = new ElevenLabsConnector();
    connector.fetcher = fetcher;
    return connector;
  }

  textToSpeech(input: TextToSpeechRequest, stream = false): Promise<BinaryResponse> {
    return this.binary(
      `/v1/text-to-speech/${encodeURIComponent(input.voiceId)}${stream ? '/stream' : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: input.text,
          ...(input.modelId && { model_id: input.modelId }),
        }),
      },
      { output_format: input.outputFormat },
      !stream,
    );
  }

  speechToSpeech(input: SpeechToSpeechRequest, stream = false): Promise<BinaryResponse> {
    const form = new FormData();
    form.append('audio', input.audio, 'audio');
    if (input.modelId) form.append('model_id', input.modelId);
    if (input.removeBackgroundNoise !== undefined) {
      form.append('remove_background_noise', String(input.removeBackgroundNoise));
    }
    return this.binary(
      `/v1/speech-to-speech/${encodeURIComponent(input.voiceId)}${stream ? '/stream' : ''}`,
      { method: 'POST', body: form },
      { output_format: input.outputFormat },
      !stream,
    );
  }

  speechToText(input: SpeechToTextRequest): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('file', input.file, 'audio');
    form.append('model_id', input.modelId ?? 'scribe_v2');
    if (input.diarize !== undefined) form.append('diarize', String(input.diarize));
    return this.json('/v1/speech-to-text', { method: 'POST', body: form });
  }

  createDubbing(input: DubbingCreateRequest): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('file', input.file, 'media');
    form.append('target_lang', input.targetLanguage);
    if (input.name) form.append('name', input.name);
    return this.json('/v1/dubbing', { method: 'POST', body: form });
  }

  getDubbing(id: string): Promise<Record<string, unknown>> {
    return this.json(`/v1/dubbing/${encodeURIComponent(id)}`);
  }

  listDubbings(
    query: { cursor?: string; pageSize?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.json('/v1/dubbing', {}, { cursor: query.cursor, page_size: query.pageSize });
  }

  getDubbedAudio(id: string, language: string): Promise<BinaryResponse> {
    return this.binary(
      `/v1/dubbing/${encodeURIComponent(id)}/audio/${encodeURIComponent(language)}`,
    );
  }

  getDubbingTranscript(
    id: string,
    language: string,
    format: string,
  ): Promise<Record<string, unknown>> {
    return this.json(
      `/v1/dubbing/${encodeURIComponent(id)}/transcripts/${encodeURIComponent(language)}/format/${encodeURIComponent(format)}`,
    );
  }

  async deleteDubbing(id: string): Promise<void> {
    await this.request(`/v1/dubbing/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  listVoices(
    query: { nextPageToken?: string; pageSize?: number; search?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.json(
      '/v2/voices',
      {},
      {
        next_page_token: query.nextPageToken,
        page_size: query.pageSize,
        search: query.search,
      },
    );
  }

  getVoice(id: string): Promise<Record<string, unknown>> {
    return this.json(`/v1/voices/${encodeURIComponent(id)}`);
  }

  listSharedVoices(
    query: { page?: number; pageSize?: number; language?: string } = {},
  ): Promise<Record<string, unknown>> {
    return this.json(
      '/v1/shared-voices',
      {},
      {
        page: query.page,
        page_size: query.pageSize,
        language: query.language,
      },
    );
  }

  private async json(
    path: string,
    init: RequestInit = {},
    query: QueryValueMap = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request(path, init, query);
    return (await response.clone().json()) as Record<string, unknown>;
  }

  private async binary(
    path: string,
    init: RequestInit = {},
    query: QueryValueMap = {},
    buffer = true,
  ): Promise<BinaryResponse> {
    const response = await this.request(path, init, query);
    const data = buffer ? await response.clone().arrayBuffer() : null;
    const cost = response.headers.get('character-cost');
    return {
      data,
      stream: response.body,
      contentType: response.headers.get('content-type'),
      requestId: response.headers.get('request-id'),
      characterCost: cost === null ? null : Number(cost),
    };
  }

  private async request(
    path: string,
    init: RequestInit = {},
    query: QueryValueMap = {},
  ): Promise<Response> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new ElevenLabsError(503, 'not_configured', 'ElevenLabs is not configured');
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = {
      'xi-api-key': apiKey,
      ...(init.headers as Record<string, string> | undefined),
    };
    const response = await this.fetcher(url, { ...init, headers });
    if (response.ok) return response;
    const raw = await response.text();
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // Preserve non-JSON provider bodies.
    }
    const detail =
      typeof body === 'object' && body !== null && 'detail' in body
        ? (body as { detail: unknown }).detail
        : body;
    const structured =
      typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
    throw new ElevenLabsError(
      response.status,
      typeof structured.status === 'string' ? structured.status : 'provider_error',
      typeof structured.message === 'string'
        ? structured.message
        : `ElevenLabs request failed (${response.status})`,
      detail,
      response.headers.get('request-id') ?? undefined,
      response.headers.get('x-trace-id') ?? undefined,
      response.headers.get('retry-after') ?? undefined,
    );
  }
}
