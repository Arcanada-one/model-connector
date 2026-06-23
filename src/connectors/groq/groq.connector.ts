import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ProviderModelMeta,
} from '../interfaces/connector.interface';
import { ModelModality, normalizePerMTokPrice } from '../dto/catalog.dto';

interface GroqChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// CONN-0236 — offline/CI fallback chat models (cited CONN-0233, reviewed 2026-06-22,
// all confirmed present in the live 2026-06-23 capture). refreshModels() fetches the
// full chat list from /openai/v1/models on boot; the audio (whisper/orpheus) and
// moderation families returned there are filtered out — they belong to the speech
// module, not this chat connector.
const GROQ_STATIC_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-safeguard-20b',
  'qwen/qwen3-32b',
  'groq/compound',
  'groq/compound-mini',
];

// Groq /models entry shape (only the fields we read for modality + pricing).
interface GroqModelEntry {
  id?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  context_window?: unknown;
  max_completion_tokens?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
}

export class GroqConnector extends BaseApiConnector {
  readonly name = 'groq';

  protected getBaseUrl(): string {
    return 'https://api.groq.com';
  }

  // CONN-0236 — Groq nests its OpenAI-compat model listing under /openai/v1.
  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/openai/v1/models`;
  }

  // CONN-0238 — static floor is chat-only and free-tier (offline/CI fallback).
  protected getStaticModels(): string[] {
    return GROQ_STATIC_MODELS;
  }

  protected getStaticModelMetas(): ProviderModelMeta[] {
    return GROQ_STATIC_MODELS.map((id) => ({ id, modality: 'chat' as ModelModality, free: true }));
  }

  /**
   * CONN-0238 — parse Groq's /models list, surfacing EVERY model with its real
   * per-model modality (operator decision — reverses CONN-0236's drop of the
   * non-chat families). Groq returns STT (whisper: output `transcription`), TTS
   * (orpheus: output `speech`), moderation (llama-prompt-guard, text→text safety
   * classifier) and chat in one list. Modality is derived from
   * `input_modalities`/`output_modalities` + the prompt-guard name. Pricing is
   * normalised to per-1M-tokens ONLY for text-output models (unambiguous per-token
   * unit); STT/TTS keep pricing null (the provider's $/hour & $/char are not
   * MTok-comparable — never mislabel). Context/max-output come straight from the
   * live entry. chat + moderation are free-tier; STT/TTS are not (priced families).
   */
  protected extractModels(json: unknown): ProviderModelMeta[] {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    const out: ProviderModelMeta[] = [];
    for (const entry of data) {
      const e = entry as GroqModelEntry;
      if (typeof e.id !== 'string' || e.id.length === 0) continue;
      const modality = this.classifyGroqModality(e);
      const textOutput = modality === 'chat' || modality === 'moderation';
      const pricing =
        textOutput && e.pricing
          ? {
              inputPerMTok: normalizePerMTokPrice(e.pricing.prompt),
              outputPerMTok: normalizePerMTokPrice(e.pricing.completion),
              unit: 'per_1m_tokens',
            }
          : null;
      // Suppress an all-null pricing object (no usable numbers) → null.
      const pricingOrNull =
        pricing && (pricing.inputPerMTok !== null || pricing.outputPerMTok !== null)
          ? pricing
          : null;
      out.push({
        id: e.id,
        modality,
        free: textOutput, // groq's chat + moderation are free-tier; STT/TTS priced
        pricing: pricingOrNull,
        contextWindow: typeof e.context_window === 'number' ? e.context_window : null,
        maxOutputTokens:
          typeof e.max_completion_tokens === 'number' ? e.max_completion_tokens : null,
      });
    }
    return out;
  }

  private classifyGroqModality(e: GroqModelEntry): ModelModality {
    const id = e.id as string;
    if (id.includes('prompt-guard')) return 'moderation';
    // Classify by OUTPUT first: whisper outputs `transcription` (STT), orpheus
    // outputs `speech` (TTS). A future audio-INPUT chat model would output `text`
    // and must stay `chat` — so we do NOT key STT off audio input alone.
    const output = Array.isArray(e.output_modalities) ? (e.output_modalities as string[]) : [];
    if (output.includes('transcription')) return 'speech_to_text';
    if (output.includes('speech')) return 'text_to_speech';
    return 'chat';
  }

  protected getTimeout(): number {
    return Number(process.env.GROQ_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.GROQ_API_KEY || '';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/openai/v1/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    // ARCA-0011: ContentBlock[] is rejected by the base-class guard
    // (`supportsContentBlocks=false`) before reaching this branch.
    if (typeof request.prompt !== 'string') {
      throw new Error('groq connector requires string prompt');
    }
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      messages,
    };

    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    if (request.extra?.max_tokens != null) {
      body.max_tokens = request.extra.max_tokens;
    }
    if (request.extra?.temperature != null) {
      body.temperature = request.extra.temperature;
    }
    if (request.extra?.top_p != null) {
      body.top_p = request.extra.top_p;
    }

    return body;
  }

  protected parseResponse(json: GroqChatResponse, request: ConnectorRequest): ParsedApiOutput {
    const choice = json.choices?.[0];
    if (!choice) {
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No choices in response',
      };
    }

    return {
      text: choice.message.content || '',
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    // CONN-0238 — static 9 (chat) until refreshModels() fetches the live 17.
    const modelMeta = this.dynamicModelMetas;
    return {
      name: 'groq',
      type: 'api',
      models: modelMeta.map((m) => m.id),
      modelMeta,
      // CONN-0233/0238 — Groq's API is free-tier (rate-limited) for chat +
      // moderation; STT/TTS are priced families (per-meta `free`). The free set is
      // derived from the per-model metadata so it never includes whisper/orpheus.
      // Source: https://console.groq.com/docs/openai (free API with rate limits).
      freeModels: modelMeta.filter((m) => m.free).map((m) => m.id),
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}
