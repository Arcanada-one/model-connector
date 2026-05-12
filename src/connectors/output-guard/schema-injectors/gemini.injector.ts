// CONN-0089 — Gemini injector (stub). Uses `generationConfig.responseSchema`
// + `responseMimeType: application/json`. Routed via `extra.generationConfig`
// so the future direct Gemini connector can forward unchanged.

import type { ConnectorCapabilities, ConnectorRequest } from '../../interfaces/connector.interface';
import type { JsonSchema } from '../ajv-adapter';
import type { SchemaInjector } from './index';

export const geminiInjector: SchemaInjector = {
  id: 'gemini',
  matches(cap: ConnectorCapabilities): boolean {
    return cap.name === 'gemini' && cap.supportsJsonSchema;
  },
  inject(request: ConnectorRequest, schema: JsonSchema | undefined): ConnectorRequest {
    if (!schema) return request;
    return {
      ...request,
      extra: {
        ...(request.extra ?? {}),
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      },
    };
  },
};
