import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';
import { buildFreeModels } from './openmodel.catalogue';

// OpenModel uses the Anthropic-compatible /v1/messages protocol.
// Confirmed via live smoke test (CONN-0223, 2026-06-21):
//   POST https://api.openmodel.ai/v1/messages with x-api-key + anthropic-version headers
//   returns Anthropic message shape. /v1/chat/completions → 404.
interface OpenModelAnthropicContentBlock {
  type: string; // 'text' | 'thinking' | ...
  text?: string;
}

interface OpenModelResponse {
  id: string;
  type: string; // 'message'
  role: string; // 'assistant'
  model: string;
  content: OpenModelAnthropicContentBlock[];
  stop_reason: string | null; // 'end_turn' | 'max_tokens' | ...
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

const DEFAULT_MODEL = 'deepseek-v4-flash';
// Required by Anthropic protocol: max_tokens must always be present in the request.
const DEFAULT_MAX_TOKENS = 4096;

// CONN-0237 — Anthropic-native JSON-mode: system instruction injected when
// responseFormat.type === 'json_object'. No OpenAI response_format field added.
const JSON_ONLY_INSTRUCTION =
  'Respond with only valid JSON. No prose, no preamble, no markdown code fences.';

// CONN-0238 — offline/CI fallback. The live OpenModel /v1/models endpoint returns
// 34 models (operator-verified 2026-06-23); refreshModels() REPLACES this floor with
// the live list on boot where OPENMODEL_API_KEY is present. The floor is trimmed to
// the single still-live cited id — the old `deepseek-r2` / `qwen3-235b` are GONE from
// the live API (CONN-0236 UNION wrongly kept them); dropping them here removes them
// offline too.
const OPENMODEL_STATIC_MODELS = ['deepseek-v4-flash'];

export class OpenModelConnector extends BaseApiConnector {
  readonly name = 'openmodel';

  protected getBaseUrl(): string {
    return process.env.OPENMODEL_BASE_URL || 'https://api.openmodel.ai/v1';
  }

  // CONN-0236 — OpenModel exposes an OpenAI/Anthropic-compatible model listing at
  // `{baseUrl}/models` (baseUrl already ends in /v1 → https://api.openmodel.ai/v1/models).
  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/models`;
  }

  protected getStaticModels(): string[] {
    return OPENMODEL_STATIC_MODELS;
  }

  protected getTimeout(): number {
    return Number(process.env.OPENMODEL_TIMEOUT_MS) || 30_000;
  }

  // Anthropic-compatible protocol: x-api-key header (not Authorization: Bearer).
  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.OPENMODEL_API_KEY || '';
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  // CONN-0236 — the chat endpoint is Anthropic-style (x-api-key), but the
  // OpenAI-compatible `/v1/models` listing requires `Authorization: Bearer`
  // (x-api-key → 401). Verified live 2026-06-23: Bearer → 200, x-api-key → 401.
  protected getModelsHeaders(): Record<string, string> {
    const apiKey = process.env.OPENMODEL_API_KEY || '';
    return {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/messages`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    // Anthropic protocol: system is a top-level field, NOT a message in the array.
    const messages: Array<{ role: string; content: string }> = [
      { role: 'user', content: String(request.prompt) },
    ];

    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      max_tokens: (request.extra?.max_tokens as number | undefined) ?? DEFAULT_MAX_TOKENS,
      messages,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (request.extra?.temperature != null) {
      body.temperature = request.extra.temperature;
    }

    // CONN-0237 — Anthropic-native JSON-mode: gated strictly on json_object.
    // Non-JSON callers (no responseFormat or type:'text') are byte-identical (V-AC-2).
    if (request.responseFormat?.type === 'json_object') {
      // Merge: preserve any existing systemPrompt, append the strict instruction.
      body.system = [request.systemPrompt, JSON_ONLY_INSTRUCTION].filter(Boolean).join('\n\n');
      // Assistant-prefill: Anthropic echoes only the continuation; parseResponse re-prepends '{'.
      messages.push({ role: 'assistant', content: '{' });
    }

    return body;
  }

  protected parseResponse(json: OpenModelResponse, request: ConnectorRequest): ParsedApiOutput {
    // content[] may include a 'thinking' block before the 'text' block — always pick
    // the first block whose type === 'text' rather than assuming content[0] is text.
    const textBlock = json.content?.find((b) => b.type === 'text');
    if (!textBlock) {
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No text block in response content',
      };
    }

    // CONN-0237 — Anthropic /v1/messages MAY echo only the continuation of an assistant
    // prefill (leading '{' absent), but some upstreams (observed: deepseek-v4-flash via the
    // openmodel endpoint) ignore the prefill and return the FULL object including '{'.
    // Re-prepend '{' only when the returned text does not already start with it — otherwise
    // we produce '{{...}' and JSON.parse fails (CONN-0237 prod regression, 2026-06-23).
    // Non-JSON path is byte-identical (V-AC-2).
    const isJsonMode = request.responseFormat?.type === 'json_object';
    const rawText = textBlock.text ?? '';
    const text = isJsonMode && !rawText.trimStart().startsWith('{') ? '{' + rawText : rawText;

    return {
      text,
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      // Free tier — cost is always zero.
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities & { freeModels: string[] } {
    // CONN-0238 — static floor (deepseek-v4-flash) until refreshModels() REPLACES it
    // with the live 34. modelMeta is exposed for catalog parity with the other
    // dynamic connectors (all-chat here, so it carries no per-model modality).
    return {
      name: 'openmodel',
      type: 'api',
      models: this.dynamicModels,
      modelMeta: this.dynamicModelMetas,
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 120_000,
      freeModels: buildFreeModels(process.env.OPENMODEL_FREE_MODELS),
    };
  }
}
