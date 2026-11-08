/**
 * Drift controls for the static protected-dispatch fence class list.
 *
 * - Every admitted class must inherit BaseApiConnector.execute (no own execute).
 * - Every non-test BaseApiConnector subclass under src/connectors/** must appear
 *   in PROTECTED_DISPATCH_FENCE_DECISIONS.
 * Mutation control: adding an execute override to an admitted class turns RED.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { describe, expect, it } from 'vitest';

import { AnthropicConnector } from './anthropic/anthropic.connector';
import { AzureOpenAiConnector } from './azure-openai/azure-openai.connector';
import { BaseApiConnector } from './base-api.connector';
import { CerebrasConnector } from './cerebras/cerebras.connector';
import { CloudflareWorkersAiConnector } from './cloudflare-workers-ai/cloudflare-workers-ai.connector';
import { CohereConnector } from './cohere/cohere.connector';
import { DeepSeekConnector } from './deepseek/deepseek.connector';
import { EmbeddingConnector } from './embedding/embedding.connector';
import { FireworksConnector } from './fireworks/fireworks.connector';
import { GeminiApiConnector } from './gemini-api/gemini-api.connector';
import { GrokConnector } from './grok/grok.connector';
import { GroqConnector } from './groq/groq.connector';
import { HuggingFaceConnector } from './huggingface/huggingface.connector';
import { JevConnector } from './jev/jev.connector';
import { JinaAiConnector } from './jina-ai/jina-ai.connector';
import { MistralConnector } from './mistral/mistral.connector';
import { OllamaCloudConnector } from './ollama-cloud/ollama-cloud.connector';
import { OllamaConnector } from './ollama/ollama.connector';
import { OpenAiConnector } from './openai/openai.connector';
import { OpenModelConnector } from './openmodel/openmodel.connector';
import { OpenRouterConnector } from './openrouter/openrouter.connector';
import { OrqConnector } from './orq/orq.connector';
import { PerplexityConnector } from './perplexity/perplexity.connector';
import { PineconeInferenceConnector } from './pinecone-inference/pinecone-inference.connector';
import {
  PROTECTED_DISPATCH_FENCE_DECISIONS,
  isProtectedDispatchFenceClassAdmitted,
  type FenceAdmissionRecord,
} from './protected-dispatch-fence-admission';
import { TogetherConnector } from './together/together.connector';
import { VertexGenerativeConnector } from './vertex-generative/vertex-generative.connector';
import { VoyageAiConnector } from './voyage-ai/voyage-ai.connector';

type ConnectorCtor = abstract new (...args: never[]) => BaseApiConnector;

const PRODUCTION_BASE_API_CONNECTORS: readonly ConnectorCtor[] = [
  AnthropicConnector,
  AzureOpenAiConnector,
  CerebrasConnector,
  CloudflareWorkersAiConnector,
  CohereConnector,
  DeepSeekConnector,
  EmbeddingConnector,
  FireworksConnector,
  GeminiApiConnector,
  GrokConnector,
  GroqConnector,
  HuggingFaceConnector,
  JevConnector,
  JinaAiConnector,
  MistralConnector,
  OllamaCloudConnector,
  OllamaConnector,
  OpenAiConnector,
  OpenModelConnector,
  OpenRouterConnector,
  OrqConnector,
  PerplexityConnector,
  PineconeInferenceConnector,
  TogetherConnector,
  VertexGenerativeConnector,
  VoyageAiConnector,
];

const CONNECTORS_ROOT = join(__dirname);

function listProductionConnectorSources(dir: string = CONNECTORS_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionConnectorSources(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.spec.ts')) continue;
    if (entry.includes('.e2e.')) continue;
    const rel = relative(CONNECTORS_ROOT, full);
    if (rel.includes(`${join('test')}`) || rel.startsWith('test/')) continue;
    const text = readFileSync(full, 'utf8');
    if (!/extends\s+BaseApiConnector\b/.test(text)) continue;
    // Spec-local subclasses live in *.spec.ts (already excluded). Skip any
    // remaining non-production helpers that are not exported connector classes.
    out.push(full);
  }
  return out;
}

function exportedClassNamesExtendingBaseApi(sourcePath: string): string[] {
  const text = readFileSync(sourcePath, 'utf8');
  const names: string[] = [];
  const re = /export\s+class\s+(\w+)\s+extends\s+BaseApiConnector\b/g;
  for (const match of text.matchAll(re)) {
    names.push(match[1]);
  }
  return names;
}

describe('PROTECTED_DISPATCH_FENCE_DECISIONS drift', () => {
  it('every admitted class prototype has no own execute', () => {
    const byName = new Map(PRODUCTION_BASE_API_CONNECTORS.map((c) => [c.name, c]));
    const admitted = PROTECTED_DISPATCH_FENCE_DECISIONS.filter((d) => d.decision === 'admitted');
    expect(admitted.length).toBeGreaterThan(0);
    for (const record of admitted) {
      const ctor = byName.get(record.className);
      expect(ctor, `missing import for admitted class ${record.className}`).toBeTruthy();
      if (!ctor) continue;
      expect(
        Object.prototype.hasOwnProperty.call(ctor.prototype, 'execute'),
        `${record.className}.prototype must not own execute (admission requires inherited BaseApiConnector.execute)`,
      ).toBe(false);
      expect(record.overridesExecute).toBe(false);
      expect(typeof record.forwardsMaxTokens).toBe('boolean');
      expect(Array.isArray(record.forwardedExtraKeys)).toBe(true);
    }
  });

  it('every non-test BaseApiConnector subclass appears in the decision list', () => {
    const listed = new Set(PROTECTED_DISPATCH_FENCE_DECISIONS.map((d) => d.className));
    const discovered = new Set<string>();
    for (const source of listProductionConnectorSources()) {
      for (const name of exportedClassNamesExtendingBaseApi(source)) {
        discovered.add(name);
      }
    }
    // Imported constructors must match the filesystem inventory.
    for (const ctor of PRODUCTION_BASE_API_CONNECTORS) {
      expect(discovered.has(ctor.name), `${ctor.name} missing from filesystem inventory`).toBe(
        true,
      );
      expect(
        listed.has(ctor.name),
        `${ctor.name} missing from PROTECTED_DISPATCH_FENCE_DECISIONS`,
      ).toBe(true);
    }
    for (const name of discovered) {
      expect(listed.has(name), `${name} found under src/connectors but not listed`).toBe(true);
    }
    // List must not contain unknown class names.
    for (const record of PROTECTED_DISPATCH_FENCE_DECISIONS as readonly FenceAdmissionRecord[]) {
      expect(discovered.has(record.className), `stale list entry ${record.className}`).toBe(true);
    }
  });

  it('refused classes: overridesExecute matches whether the prototype owns execute', () => {
    // Policy refusals (e.g. Perplexity Stage A exclusion) may refuse a class that
    // still inherits BaseApiConnector.execute; structural refusals mark overrides.
    const byName = new Map(PRODUCTION_BASE_API_CONNECTORS.map((c) => [c.name, c]));
    for (const record of PROTECTED_DISPATCH_FENCE_DECISIONS) {
      if (record.decision !== 'refused') continue;
      const ctor = byName.get(record.className);
      expect(ctor, `missing import for refused class ${record.className}`).toBeTruthy();
      if (!ctor) continue;
      const ownsExecute = Object.prototype.hasOwnProperty.call(ctor.prototype, 'execute');
      expect(record.overridesExecute).toBe(ownsExecute);
    }
  });

  it('M-PPLX-EXCLUDE: PerplexityConnector is refused from the protected fence', () => {
    const record = PROTECTED_DISPATCH_FENCE_DECISIONS.find(
      (d) => d.className === 'PerplexityConnector',
    );
    expect(record?.decision).toBe('refused');
    expect(record?.reason).toMatch(/6728472574/);
    expect(isProtectedDispatchFenceClassAdmitted('PerplexityConnector')).toBe(false);
  });
});
