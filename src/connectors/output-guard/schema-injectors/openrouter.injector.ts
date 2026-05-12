// CONN-0089 — OpenRouter injector. Sets `extra.response_format` to OpenAI-style
// `json_schema` payload when the connector advertises supportsJsonSchema=true.

import type { ConnectorCapabilities, ConnectorRequest } from '../../interfaces/connector.interface';
import type { JsonSchema } from '../ajv-adapter';
import type { SchemaInjector } from './index';

export const openrouterInjector: SchemaInjector = {
  id: 'openrouter',
  matches(cap: ConnectorCapabilities): boolean {
    return cap.name === 'openrouter' && cap.supportsJsonSchema;
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
