import { z } from 'zod';
import { CARTESIA_API_VERSION, CARTESIA_TTS_MODELS } from './model-catalog';
import type { CartesiaHttpPort, CartesiaWebSocketPort } from './ports';
import {
  providerErrorSchema,
  ttsRequestSchema,
  voiceListSchema,
  voiceSchema,
  type CartesiaTtsRequest,
  type CartesiaVoice,
} from './schemas';

const BASE_URL = 'https://api.cartesia.ai';
const WS_URL = 'wss://api.cartesia.ai';

export class CartesiaProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly errorCode: string,
    readonly requestId?: string,
    readonly contextId?: string,
  ) {
    super(message);
    this.name = 'CartesiaProviderError';
  }
}

export interface VoiceListParams {
  limit?: number;
  starting_after?: string;
  ending_before?: string;
  q?: string;
  is_owner?: boolean;
  gender?: 'masculine' | 'feminine' | 'gender_neutral';
  language?: string;
}

export class CartesiaClient {
  constructor(
    private readonly options: {
      apiKey: string;
      http: CartesiaHttpPort;
      websocket: CartesiaWebSocketPort;
      baseUrl?: string;
      websocketUrl?: string;
    },
  ) {
    if (!options.apiKey) throw new Error('Cartesia API key is required');
    if (!this.httpBase().startsWith('https://') || !this.wsBase().startsWith('wss://')) {
      throw new Error('Cartesia transport requires HTTPS and WSS');
    }
  }

  async ttsBytes(input: CartesiaTtsRequest): Promise<Buffer> {
    const body = ttsRequestSchema.parse(input);
    const response = await this.options.http.request({
      method: 'POST',
      path: '/tts/bytes',
      headers: this.headers(true),
      body,
    });
    if (response.status >= 400) this.throwHttpError(response.status, response.body);
    return response.body;
  }

  async listVoices(
    params: VoiceListParams = {},
  ): Promise<{ data: CartesiaVoice[]; hasMore: boolean; nextCursor?: string }> {
    if (
      params.limit !== undefined &&
      (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)
    )
      throw new Error('Voice limit must be between 1 and 100');
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, String(value));
    const suffix = query.size ? `?${query.toString()}` : '';
    const response = await this.options.http.request({
      method: 'GET',
      path: `/voices${suffix}`,
      headers: this.headers(),
    });
    if (response.status >= 400) this.throwHttpError(response.status, response.body);
    const page = voiceListSchema.parse(JSON.parse(response.body.toString('utf8')));
    return {
      data: page.data,
      hasMore: page.has_more,
      nextCursor: page.has_more ? page.data.at(-1)?.id : undefined,
    };
  }

  async getVoice(id: string): Promise<CartesiaVoice> {
    if (!id) throw new Error('Voice ID is required');
    const response = await this.options.http.request({
      method: 'GET',
      path: `/voices/${encodeURIComponent(id)}`,
      headers: this.headers(),
    });
    if (response.status >= 400) this.throwHttpError(response.status, response.body);
    return voiceSchema.parse(JSON.parse(response.body.toString('utf8')));
  }

  listModels(): typeof CARTESIA_TTS_MODELS {
    return CARTESIA_TTS_MODELS;
  }

  connectWebSocket() {
    return this.options.websocket.connect({
      url: `${this.wsBase()}/tts/websocket?cartesia_version=${CARTESIA_API_VERSION}`,
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
  }

  generationMessage(input: CartesiaTtsRequest & { context_id: string; continue?: boolean }) {
    const { context_id, continue: shouldContinue = false, ...request } = input;
    return { ...ttsRequestSchema.parse(request), context_id, continue: shouldContinue };
  }

  flushMessage(contextId: string) {
    return { context_id: contextId, transcript: '', continue: false };
  }
  cancelMessage(contextId: string) {
    return { context_id: contextId, cancel: true };
  }

  parseWebSocketFrame(raw: string): Record<string, unknown> {
    let frame: Record<string, unknown>;
    try {
      frame = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
    } catch {
      throw new Error('Invalid Cartesia WebSocket frame');
    }
    if (frame.type === 'error') {
      throw new CartesiaProviderError(
        String(frame.message),
        Number(frame.status_code),
        String(frame.error_code),
        String(frame.request_id),
        String(frame.context_id),
      );
    }
    if (frame.type === 'chunk') {
      if (
        typeof frame.data !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
      )
        throw new Error('Invalid Cartesia base64 audio chunk');
      return { ...frame, audio: Buffer.from(frame.data, 'base64') };
    }
    if (['flush_done', 'done', 'timestamps', 'phoneme_timestamps'].includes(String(frame.type)))
      return frame;
    throw new Error('Unsupported Cartesia WebSocket frame type');
  }

  private headers(json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Cartesia-Version': CARTESIA_API_VERSION,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }
  private httpBase() {
    return this.options.baseUrl ?? BASE_URL;
  }
  private wsBase() {
    return this.options.websocketUrl ?? WS_URL;
  }
  private throwHttpError(status: number, body: Buffer): never {
    try {
      const error = providerErrorSchema.parse(JSON.parse(body.toString('utf8')));
      throw new CartesiaProviderError(error.message, status, error.error_code, error.request_id);
    } catch (error) {
      if (error instanceof CartesiaProviderError) throw error;
      throw new CartesiaProviderError('Cartesia request failed', status, 'provider_error');
    }
  }
}
