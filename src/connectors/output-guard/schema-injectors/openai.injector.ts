// CONN-0089 — OpenAI Structured Outputs injector (stub for future direct
// OpenAI connector). Mirrors Responses API `text.format.json_schema` shape.

import type { ConnectorCapabilities, ConnectorRequest } from '../../interfaces/connector.interface';
import type { JsonSchema } from '../ajv-adapter';
import type { SchemaInjector } from './index';

export const openaiInjector: SchemaInjector = {
  id: 'openai',
  matches(cap: ConnectorCapabilities): boolean {
    return cap.name === 'openai' && cap.supportsJsonSchema;
  },
  inject(request: ConnectorRequest, schema: JsonSchema | undefined): ConnectorRequest {
    if (!schema) return request;
    return {
      ...request,
      extra: {
        ...(request.extra ?? {}),
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'output_guard_schema', strict: true, schema },
        },
      },
    };
  },
};
