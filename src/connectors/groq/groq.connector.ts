import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

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

// Groq /models entry shape (only the fields we read for chat-modality filtering).
interface GroqModelEntry {
  id?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
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

  protected getStaticModels(): string[] {
    return GROQ_STATIC_MODELS;
  }

  /**
   * CONN-0236 — parse Groq's /models list, keeping only chat (text) models. Groq
   * returns STT (whisper: input `audio`, output `transcription`), TTS (orpheus:
   * output `speech`) and moderation families in the same list; this chat connector
   * must not surface the non-text ones (the speech module owns them). A model is
   * "chat" here when its OUTPUT is text-only and its INPUT is text and/or image
   * (multimodal vision chat is still chat). Entries without modality fields are kept
   * — other OpenAI-compat providers omit them and are chat-only. Moderation
   * classifiers (llama-prompt-guard-*) are text→text but not conversational, so they
   * are excluded by name — Groq documents them as a separate safety family.
   */
  protected extractModelIds(json: unknown): string[] {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    const ALLOWED_INPUT = new Set(['text', 'image']);
    const ALLOWED_OUTPUT = new Set(['text']);
    const within = (mods: unknown, allowed: Set<string>): boolean =>
      mods === undefined || (Array.isArray(mods) && mods.every((m) => allowed.has(m as string)));
    const isNonChatByName = (id: string): boolean => id.includes('prompt-guard');
    return data
      .filter((entry) => {
        const e = entry as GroqModelEntry;
        return (
          within(e.input_modalities, ALLOWED_INPUT) && within(e.output_modalities, ALLOWED_OUTPUT)
        );
      })
      .map((entry) => (entry as GroqModelEntry).id)
      .filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && !isNonChatByName(id),
      );
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
    // CONN-0236 — static 9 until refreshModels() fetches the live chat list.
    const models = this.dynamicModels;
    return {
      name: 'groq',
      type: 'api',
      models,
      // CONN-0233 — reviewed 2026-06-22: Groq's API is free-tier (rate-limited).
      // Every chat model Groq lists is accessible via the free API tier, so the
      // free set tracks the dynamic model list 1:1.
      // Source: https://console.groq.com/docs/openai (free API with rate limits).
      freeModels: models,
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}
