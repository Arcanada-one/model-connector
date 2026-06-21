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

export class OpenModelConnector extends BaseApiConnector {
  readonly name = 'openmodel';

  protected getBaseUrl(): string {
    return process.env.OPENMODEL_BASE_URL || 'https://api.openmodel.ai/v1';
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

    return {
      text: textBlock.text || '',
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      // Free tier — cost is always zero.
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities & { freeModels: string[] } {
    return {
      name: 'openmodel',
      type: 'api',
      models: ['deepseek-v4-flash', 'deepseek-r2', 'qwen3-235b'],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 120_000,
      freeModels: buildFreeModels(process.env.OPENMODEL_FREE_MODELS),
    };
  }
}
