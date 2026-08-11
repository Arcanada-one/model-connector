import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ContentBlock,
} from '../interfaces/connector.interface';

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicMessageResponse {
  model?: string;
  content?: Array<AnthropicTextBlock | AnthropicToolUseBlock | { type: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 4096;
const STATIC_MODELS = ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'];

export class AnthropicConnector extends BaseApiConnector {
  readonly name = 'anthropic';

  protected getBaseUrl(): string {
    return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
  }

  protected getStaticModels(): string[] {
    return STATIC_MODELS;
  }

  protected getTimeout(): number {
    return Number(process.env.ANTHROPIC_TIMEOUT_MS) || 120_000;
  }

  protected get supportsContentBlocks(): boolean {
    return true;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/messages`;
  }

  private mapContentBlock(block: ContentBlock): Record<string, unknown> {
    if (block.type === 'text') return block;

    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(block.image_url.url);
    if (!match) {
      throw new Error('Anthropic image prompts require a base64 data URL');
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] },
    };
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const content = Array.isArray(request.prompt)
      ? request.prompt.map((block) => this.mapContentBlock(block))
      : String(request.prompt);
    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      max_tokens: (request.extra?.max_tokens as number | undefined) ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content }],
    };

    if (request.systemPrompt) body.system = request.systemPrompt;
    if (request.extra?.temperature != null) body.temperature = request.extra.temperature;
    if (request.extra?.stop_sequences != null) body.stop_sequences = request.extra.stop_sequences;
    if (request.extra?.tools != null) body.tools = request.extra.tools;
    if (request.extra?.tool_choice != null) body.tool_choice = request.extra.tool_choice;
    return body;
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as AnthropicMessageResponse;
    const content = Array.isArray(response.content) ? response.content : [];
    const text = content
      .filter((block): block is AnthropicTextBlock => block.type === 'text' && 'text' in block)
      .map((block) => block.text)
      .join('\n');
    const toolCalls = content
      .filter(
        (block): block is AnthropicToolUseBlock =>
          block.type === 'tool_use' && 'id' in block && 'name' in block && 'input' in block,
      )
      .map(({ id, name, input }) => ({ id, name, input }));

    if (!text && toolCalls.length === 0) {
      return {
        text: '',
        model: response.model || request.model || DEFAULT_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No supported content blocks in response',
      };
    }

    return {
      text,
      structured:
        toolCalls.length > 0 ? { stopReason: response.stop_reason ?? null, toolCalls } : undefined,
      model: response.model || request.model || DEFAULT_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: this.dynamicModels,
      modelMeta: this.dynamicModelMetas,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: true,
      maxTimeout: 300_000,
      modality: 'chat',
    };
  }
}
