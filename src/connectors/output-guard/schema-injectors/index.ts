// CONN-0089 — schema-injector registry. Maps provider capability to a
// strategy that augments the outgoing ConnectorRequest with native
// structured-output hints when available; otherwise a no-op.

import type { ConnectorCapabilities, ConnectorRequest } from '../../interfaces/connector.interface';
import type { JsonSchema } from '../ajv-adapter';
import { openrouterInjector } from './openrouter.injector';
import { openaiInjector } from './openai.injector';
import { anthropicInjector } from './anthropic.injector';
import { geminiInjector } from './gemini.injector';
import { cliInjector } from './cli.injector';

export interface SchemaInjector {
  /** Stable identifier used by registry + metrics. */
  readonly id: string;
  /** Returns true if this injector applies to the given connector. */
  matches(capabilities: ConnectorCapabilities): boolean;
  /** Returns a (shallow-cloned) request augmented with native structured-output hints. */
  inject(request: ConnectorRequest, schema: JsonSchema | undefined): ConnectorRequest;
}

const INJECTORS: SchemaInjector[] = [
  openrouterInjector,
  openaiInjector,
  anthropicInjector,
  geminiInjector,
  cliInjector,
];

/**
 * Pick a schema injector for the connector. Falls back to CLI prompt-injection
 * injector for any capability not covered by a provider-native mapper.
 */
export function pickInjector(capabilities: ConnectorCapabilities): SchemaInjector {
  for (const inj of INJECTORS) {
    if (inj.matches(capabilities)) return inj;
  }
  return cliInjector;
}

export { openrouterInjector, openaiInjector, anthropicInjector, geminiInjector, cliInjector };
