// CONN-0089 — CLI fallback injector. CLI connectors lack json_schema /
// structured-output APIs (CONN-0019 known limitation). We append an
// instruction to the system prompt telling the model to emit the schema
// as raw JSON only. The library performs the actual repair pass.

import type { ConnectorCapabilities, ConnectorRequest } from '../../interfaces/connector.interface';
import type { JsonSchema } from '../ajv-adapter';
import type { SchemaInjector } from './index';

const PROMPT_HEADER =
  'You MUST respond with a single JSON value that strictly validates against the schema below. ' +
  'No prose, no markdown fences, no commentary.';

function compactSchema(schema: JsonSchema): string {
  // Compact JSON keeps prompt token-budget bounded.
  return JSON.stringify(schema);
}

export const cliInjector: SchemaInjector = {
  id: 'cli',
  matches(_cap: ConnectorCapabilities): boolean {
    // Default fallback — registry picks this last.
    return true;
  },
  inject(request: ConnectorRequest, schema: JsonSchema | undefined): ConnectorRequest {
    if (!schema) return request;
    const block = `${PROMPT_HEADER}\n\nSchema:\n${compactSchema(schema)}`;
    const merged = request.systemPrompt ? `${request.systemPrompt}\n\n${block}` : block;
    return { ...request, systemPrompt: merged };
  },
};
