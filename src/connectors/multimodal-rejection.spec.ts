import { describe, it, expect } from 'vitest';
import { ClaudeCodeConnector } from './claude-code/claude-code.connector';
import { CursorConnector } from './cursor/cursor.connector';
import { GeminiConnector } from './gemini/gemini.connector';
import { CodexConnector } from './codex/codex.connector';
import { EmbeddingConnector } from './embedding/embedding.connector';
import { GroqConnector } from './groq/groq.connector';
import { GrokConnector } from './grok/grok.connector';
import { OpenRouterConnector } from './openrouter/openrouter.connector';
import { ConnectorRequest, IConnector } from './interfaces/connector.interface';

// ARCA-0011 — per-CLI runtime guard for ContentBlock[] prompts.
// In Phase 1 only OpenRouter accepts multimodal; all other connectors must
// short-circuit with status='error' / type='unsupported_modality' BEFORE
// spawning binaries or making upstream HTTP calls.

const multimodalRequest: ConnectorRequest = {
  prompt: [
    { type: 'text', text: 'Describe.' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    },
  ],
};

const cases: Array<{ name: string; ctor: new () => IConnector }> = [
  { name: 'claude-code', ctor: ClaudeCodeConnector },
  { name: 'cursor', ctor: CursorConnector },
  { name: 'gemini', ctor: GeminiConnector },
  { name: 'codex', ctor: CodexConnector },
  { name: 'embedding', ctor: EmbeddingConnector },
  { name: 'groq', ctor: GroqConnector },
  { name: 'grok', ctor: GrokConnector },
];

describe('ARCA-0011 unsupported_modality guard (non-openrouter)', () => {
  for (const { name, ctor } of cases) {
    it(`${name} rejects ContentBlock[] without invoking upstream`, async () => {
      const connector = new ctor();
      const response = await connector.execute(multimodalRequest);
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('unsupported_modality');
      expect(response.error?.retryable).toBe(false);
      expect(response.error?.recommendation).toBe('abort');
    });
  }

  it('openrouter accepts ContentBlock[] (supports multimodal)', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    const connector = new OpenRouterConnector();
    const fetchSpy = (await import('vitest')).vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        id: 'gen-1',
        model: 'anthropic/claude-sonnet-4',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'A picture.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
    });
    (await import('vitest')).vi.stubGlobal('fetch', fetchSpy);
    const response = await connector.execute(multimodalRequest);
    expect(response.status).toBe('success');
    delete process.env.OPENROUTER_API_KEY;
    (await import('vitest')).vi.unstubAllGlobals();
  });
});
