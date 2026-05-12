import { describe, expect, it } from 'vitest';

import type { ConnectorCapabilities, ConnectorRequest } from '../../interfaces/connector.interface';
import {
  anthropicInjector,
  cliInjector,
  geminiInjector,
  openaiInjector,
  openrouterInjector,
  pickInjector,
} from './index';

function caps(over: Partial<ConnectorCapabilities>): ConnectorCapabilities {
  return {
    name: 'openrouter',
    type: 'api',
    models: [],
    supportsStreaming: false,
    supportsJsonSchema: true,
    supportsTools: false,
    maxTimeout: 60_000,
    ...over,
  };
}

const baseRequest: ConnectorRequest = { prompt: 'hello' };
const schema = { type: 'object', properties: { name: { type: 'string' } } };

describe('schema-injectors registry', () => {
  it('picks openrouter for openrouter+jsonSchema', () => {
    expect(pickInjector(caps({ name: 'openrouter' })).id).toBe('openrouter');
  });

  it('picks openai for openai+jsonSchema', () => {
    expect(pickInjector(caps({ name: 'openai' })).id).toBe('openai');
  });

  it('picks anthropic for anthropic+jsonSchema', () => {
    expect(pickInjector(caps({ name: 'anthropic' })).id).toBe('anthropic');
  });

  it('picks gemini for gemini+jsonSchema', () => {
    expect(pickInjector(caps({ name: 'gemini' })).id).toBe('gemini');
  });

  it('falls back to cli for CLI-typed connectors', () => {
    expect(
      pickInjector(caps({ name: 'claude-code', type: 'cli', supportsJsonSchema: false })).id,
    ).toBe('cli');
  });

  it('falls back to cli for openrouter when supportsJsonSchema=false', () => {
    expect(pickInjector(caps({ name: 'openrouter', supportsJsonSchema: false })).id).toBe('cli');
  });

  it('openrouter injector emits response_format.json_schema', () => {
    const out = openrouterInjector.inject(baseRequest, schema);
    expect((out.extra as { response_format: { type: string } }).response_format.type).toBe(
      'json_schema',
    );
  });

  it('openai injector emits response_format.json_schema with strict=true', () => {
    const out = openaiInjector.inject(baseRequest, schema);
    const rf = (out.extra as { response_format: { json_schema: { strict: boolean } } })
      .response_format;
    expect(rf.json_schema.strict).toBe(true);
  });

  it('anthropic injector forces a single emit tool', () => {
    const out = anthropicInjector.inject(baseRequest, schema);
    const tools = (out.extra as { tools: Array<{ name: string }> }).tools;
    expect(tools[0].name).toBe('output_guard_emit');
  });

  it('gemini injector sets responseMimeType + responseSchema', () => {
    const out = geminiInjector.inject(baseRequest, schema);
    const gc = (out.extra as { generationConfig: { responseMimeType: string } }).generationConfig;
    expect(gc.responseMimeType).toBe('application/json');
  });

  it('cli injector appends schema instruction to systemPrompt', () => {
    const out = cliInjector.inject(baseRequest, schema);
    expect(out.systemPrompt).toContain('You MUST respond with a single JSON value');
    expect(out.systemPrompt).toContain('"properties"');
  });

  it('no-ops when schema is undefined', () => {
    expect(openrouterInjector.inject(baseRequest, undefined)).toEqual(baseRequest);
    expect(cliInjector.inject(baseRequest, undefined)).toEqual(baseRequest);
  });
});
