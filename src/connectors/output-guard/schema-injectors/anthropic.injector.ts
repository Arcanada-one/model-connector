// CONN-0089 — Anthropic injector (stub). Forces structured output via a
// single tool definition + `tool_choice` forcing that tool. Used by future
// direct Anthropic connector — no-op against current MC connector roster.

import type { ConnectorCapabilities, ConnectorRequest } from '../../interfaces/connector.interface';
import type { JsonSchema } from '../ajv-adapter';
import type { SchemaInjector } from './index';

export const anthropicInjector: SchemaInjector = {
  id: 'anthropic',
  matches(cap: ConnectorCapabilities): boolean {
    return cap.name === 'anthropic' && cap.supportsJsonSchema;
  },
  inject(request: ConnectorRequest, schema: JsonSchema | undefined): ConnectorRequest {
    if (!schema) return request;
    return {
      ...request,
      extra: {
        ...(request.extra ?? {}),
        tools: [
          {
            name: 'output_guard_emit',
            description: 'Emit the structured response payload.',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'tool', name: 'output_guard_emit' },
      },
    };
  },
};
