// CONN-0243 — pure translation between the OpenAI chat-completions wire shape and
// the internal ConnectorRequest / ConnectorResponse contracts. No I/O, no NestJS.

import { randomUUID } from 'crypto';
import {
  ConnectorRequest,
  ConnectorResponse,
  ConnectorCapabilities,
  ProviderModelMeta,
} from '../connectors/interfaces/connector.interface';
import { ModelModality } from '../connectors/dto/catalog.dto';
import type { OpenAiChatCompletionRequest, OpenAiChatMessage } from './dto/openai-chat.dto';

// ─── Inbound: OpenAI request → ConnectorRequest ──────────────────────────────

/** Flatten an OpenAI message content (string | content-part[]) into plain text. */
function messageText(content: OpenAiChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
          ? part.text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export interface TranslatedRequest {
  request: Omit<ConnectorRequest, 'connector'>;
  requestedModel: string;
}

/**
 * Map an OpenAI chat-completions body to a ConnectorRequest. System messages become
 * `systemPrompt`; the remaining turns become `prompt` (a single content for a single
 * turn, or a role-labelled transcript for multi-turn). `model` is surfaced separately
 * as a routing preference (the failover gateway treats it as a hint, not a constraint).
 */
export function toConnectorRequest(body: OpenAiChatCompletionRequest): TranslatedRequest {
  const systemParts: string[] = [];
  const turns: { role: string; text: string }[] = [];

  for (const m of body.messages) {
    const text = messageText(m.content);
    if (m.role === 'system') {
      systemParts.push(text);
    } else {
      turns.push({ role: m.role, text });
    }
  }

  let prompt: string;
  if (turns.length === 0) {
    prompt = '';
  } else if (turns.length === 1) {
    prompt = turns[0].text;
  } else {
    // Multi-turn: preserve the conversation as a labelled transcript.
    prompt = turns
      .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
      .join('\n\n');
  }

  const request: Omit<ConnectorRequest, 'connector'> = { prompt };
  if (systemParts.length) request.systemPrompt = systemParts.join('\n\n');
  if (body.response_format?.type === 'json_object') {
    request.responseFormat = { type: 'json_object' };
  }

  const extra: Record<string, unknown> = {};
  if (typeof body.temperature === 'number') extra.temperature = body.temperature;
  if (typeof body.top_p === 'number') extra.top_p = body.top_p;
  if (typeof body.max_tokens === 'number') extra.max_tokens = body.max_tokens;
  if (Object.keys(extra).length) request.extra = extra;

  return { request, requestedModel: body.model };
}

// ─── Outbound: ConnectorResponse → OpenAI ChatCompletion ─────────────────────

export interface OpenAiChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Map a successful ConnectorResponse to an OpenAI ChatCompletion. usage fields are
 * renamed to OpenAI's snake_case (inputTokens→prompt_tokens, etc.) and costUsd is
 * dropped (non-OpenAI). finish_reason is 'stop' (R-F5: ConnectorResponse carries no
 * stop reason; richer mapping is a follow-up).
 */
export function toOpenAiChatCompletion(
  resp: ConnectorResponse,
  nowUnixSeconds: number,
): OpenAiChatCompletion {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: nowUnixSeconds,
    model: resp.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: resp.result },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: resp.usage.inputTokens,
      completion_tokens: resp.usage.outputTokens,
      total_tokens: resp.usage.totalTokens,
    },
  };
}

// ─── Outbound: capabilities → OpenAI model list ──────────────────────────────

export interface OpenAiModelList {
  object: 'list';
  data: Array<{ id: string; object: 'model'; created: number; owned_by: string }>;
}

/**
 * Build the OpenAI `GET /v1/models` list from in-memory connector capabilities
 * (R-F3: no getCatalog/getStatus network probes). Only chat models are listed
 * (the only modality the /v1/chat/completions path serves); deduped by id.
 */
export function toOpenAiModelList(
  capabilities: ConnectorCapabilities[],
  nowUnixSeconds: number,
): OpenAiModelList {
  const seen = new Set<string>();
  const data: OpenAiModelList['data'] = [];

  for (const caps of capabilities) {
    const connectorModality: ModelModality = caps.modality ?? 'chat';
    const metas: ProviderModelMeta[] = caps.modelMeta?.length
      ? caps.modelMeta
      : caps.models.map((id) => ({ id }));
    for (const meta of metas) {
      const modality: ModelModality = meta.modality ?? connectorModality;
      if (modality !== 'chat') continue;
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      data.push({ id: meta.id, object: 'model', created: nowUnixSeconds, owned_by: caps.name });
    }
  }

  return { object: 'list', data };
}
