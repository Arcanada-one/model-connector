import { describe, it, expect } from 'vitest';
import { GeminiConnector } from './gemini.connector';
import { ConnectorRequest } from '../interfaces/connector.interface';

// Expose protected methods for testing
class TestGeminiConnector extends GeminiConnector {
  public testBuildArgs(request: ConnectorRequest): string[] {
    return this.buildArgs(request);
  }

  public testParseOutput(stdout: string, stderr: string) {
    return this.parseOutput(stdout, stderr);
  }

  public testClassifyError(msg: string, code: number) {
    return this.classifyError(msg, code);
  }
}

// Fixture 1: success (from CONN-0007-fixtures.md)
const successFixture = JSON.stringify({
  session_id: '5ec9f4c9-c5af-4694-b473-6aaed2d769d6',
  response: 'hello world',
  stats: {
    models: {
      'gemini-2.5-flash': {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 1391 },
        tokens: {
          input: 5181, prompt: 5181, candidates: 2,
          total: 5215, cached: 0, thoughts: 32, tool: 0,
        },
      },
    },
    tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, totalDurationMs: 0 },
    files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
  },
});

// Fixture 2: error JSON (from stderr, CONN-0007-fixtures.md)
const errorJson = JSON.stringify({
  session_id: '65fcaf3a-e59d-41b5-ba91-70b76ec561cc',
  error: { type: 'Error', message: 'Requested entity was not found.', code: 1 },
});

const stderrWithError = [
  'Loaded cached credentials.',
  '[ERROR] [IDEClient] Failed to connect to IDE companion extension.',
  'Error when talking to Gemini API ModelNotFoundError: Requested entity was not found.',
  '    at classifyGoogleError (file:///...)',
  errorJson,
].join('\n');

describe('GeminiConnector', () => {
  const connector = new TestGeminiConnector();

  describe('buildArgs', () => {
    it('should build args for basic prompt', () => {
      const args = connector.testBuildArgs({ prompt: 'hello world' });
      expect(args).toEqual([
        '-p', 'hello world', '-m', 'gemini-2.5-flash', '--output-format', 'json',
      ]);
    });

    it('should use specified model', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', model: 'gemini-3-flash-preview' });
      expect(args).toContain('-m');
      expect(args).toContain('gemini-3-flash-preview');
    });

    it('should include --sandbox from extra', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', extra: { sandbox: true } });
      expect(args).toContain('--sandbox');
    });
  });

  describe('parseOutput — success', () => {
    it('should parse success JSON from stdout', () => {
      const parsed = connector.testParseOutput(successFixture, '');
      expect(parsed.text).toBe('hello world');
      expect(parsed.isError).toBe(false);
      expect(parsed.model).toBe('gemini-2.5-flash');
      expect(parsed.inputTokens).toBe(5181);
      expect(parsed.outputTokens).toBe(2);
      expect(parsed.costUsd).toBe(0);
      expect(parsed.structured).toMatchObject({
        sessionId: '5ec9f4c9-c5af-4694-b473-6aaed2d769d6',
      });
    });

    it('should strip markdown backtick wrapper from response', () => {
      const wrapped = JSON.stringify({
        session_id: 'abc',
        response: '```json\n{"key": "value"}\n```',
        stats: { models: {}, tools: { totalCalls: 0 }, files: {} },
      });
      const parsed = connector.testParseOutput(wrapped, '');
      expect(parsed.text).toBe('{"key": "value"}');
      expect(parsed.isError).toBe(false);
    });

    it('should extract model name from stats.models key', () => {
      const fixture = JSON.stringify({
        session_id: 'abc',
        response: 'ok',
        stats: {
          models: { 'gemini-3-flash-preview': { api: {}, tokens: { input: 10, candidates: 5 } } },
          tools: { totalCalls: 0 },
          files: {},
        },
      });
      const parsed = connector.testParseOutput(fixture, '');
      expect(parsed.model).toBe('gemini-3-flash-preview');
    });
  });

  describe('parseOutput — error', () => {
    it('should parse error JSON from stderr when stdout is empty', () => {
      const parsed = connector.testParseOutput('', stderrWithError);
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toBe('Requested entity was not found.');
      expect(parsed.structured).toMatchObject({
        sessionId: '65fcaf3a-e59d-41b5-ba91-70b76ec561cc',
      });
    });

    it('should handle empty stdout and empty stderr', () => {
      const parsed = connector.testParseOutput('', '');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toBe('No output');
    });

    it('should handle malformed stdout as error', () => {
      const parsed = connector.testParseOutput('not json', '');
      expect(parsed.text).toBe('not json');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toBe('Failed to parse Gemini JSON output');
    });
  });

  describe('classifyError', () => {
    it('should classify rate limit errors', () => {
      expect(connector.testClassifyError('quota exhausted', 1)).toBe('rate_limited');
      expect(connector.testClassifyError('capacity exceeded', 1)).toBe('rate_limited');
      expect(connector.testClassifyError('429 Too Many Requests', 1)).toBe('rate_limited');
    });

    it('should classify model not found errors', () => {
      expect(connector.testClassifyError('Requested entity was not found.', 1)).toBe('model_not_found');
      expect(connector.testClassifyError('ModelNotFoundError: not found', 1)).toBe('model_not_found');
    });

    it('should classify auth errors', () => {
      expect(connector.testClassifyError('not logged in', 1)).toBe('auth_error');
      expect(connector.testClassifyError('unauthorized access', 1)).toBe('auth_error');
    });

    it('should fall back to base classification', () => {
      expect(connector.testClassifyError('', 127)).toBe('binary_not_found');
      expect(connector.testClassifyError('something unknown', 1)).toBe('execution_error');
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capability schema', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('gemini');
      expect(caps.type).toBe('cli');
      expect(caps.models).toEqual([
        'gemini-2.5-flash',
        'gemini-3-flash-preview',
        'gemini-2.5-flash-lite',
      ]);
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(false);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxTimeout).toBe(600_000);
    });
  });
});
