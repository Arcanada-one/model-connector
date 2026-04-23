import { describe, it, expect } from 'vitest';
import { CodexConnector } from './codex.connector';
import { ConnectorRequest } from '../interfaces/connector.interface';

// Expose protected methods for testing
class TestCodexConnector extends CodexConnector {
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

// Fixture: success JSONL (from CONN-0042-fixtures.md — expected format)
const successJsonl = [
  '{"type":"thread.started","thread_id":"019dbc70-aaaa-bbbb-cccc-dddddddddddd"}',
  '{"type":"turn.started"}',
  '{"type":"message.delta","delta":{"content":"4"}}',
  '{"type":"message.completed","message":{"id":"msg_001","type":"message","role":"assistant","content":"4"}}',
  '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":5,"total_tokens":125}}',
].join('\n');

// Fixture: error JSONL (from CONN-0042-fixtures.md — captured live)
const errorJsonl = [
  '{"type":"thread.started","thread_id":"019dbc70-24ad-7242-894e-b35b8e8637df"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `o4-mini` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}',
  '{"type":"turn.failed","error":{"message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}}',
].join('\n');

// Fixture: stderr noise from Rust logger
const stderrNoise = [
  '2026-04-23T22:22:38.544773Z ERROR codex_core::auth: Failed to refresh token: 401 Unauthorized',
  '2026-04-23T22:22:39.277039Z ERROR codex_core::models_manager::manager: failed to refresh available models',
].join('\n');

describe('CodexConnector', () => {
  const connector = new TestCodexConnector();

  describe('buildArgs', () => {
    it('should build args with default model', () => {
      const args = connector.testBuildArgs({ prompt: 'hello world' });
      expect(args).toEqual([
        'exec',
        '--model',
        'o4-mini',
        '--json',
        '--full-auto',
        '--ephemeral',
        '--skip-git-repo-check',
        'hello world',
      ]);
    });

    it('should use specified model', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', model: 'o3' });
      expect(args).toContain('--model');
      expect(args).toContain('o3');
    });

    it('should prepend JSON instruction when responseFormat is json_object', () => {
      const args = connector.testBuildArgs({
        prompt: 'list items',
        responseFormat: { type: 'json_object' },
      });
      const prompt = args[args.length - 1];
      expect(prompt).toContain('valid JSON only');
      expect(prompt).toContain('list items');
    });

    it('should NOT modify prompt when responseFormat is not set', () => {
      const args = connector.testBuildArgs({ prompt: 'hello' });
      const prompt = args[args.length - 1];
      expect(prompt).toBe('hello');
    });
  });

  describe('parseOutput — success', () => {
    it('should parse success JSONL and extract message + usage', () => {
      const parsed = connector.testParseOutput(successJsonl, '');
      expect(parsed.text).toBe('4');
      expect(parsed.isError).toBe(false);
      expect(parsed.model).toBe('o4-mini');
      expect(parsed.inputTokens).toBe(120);
      expect(parsed.outputTokens).toBe(5);
      expect(parsed.costUsd).toBe(0);
    });

    it('should extract thread_id in structured field', () => {
      const parsed = connector.testParseOutput(successJsonl, '');
      expect(parsed.structured).toMatchObject({
        threadId: '019dbc70-aaaa-bbbb-cccc-dddddddddddd',
      });
    });

    it('should handle success with only message.completed (no delta)', () => {
      const minimal = [
        '{"type":"thread.started","thread_id":"abc-123"}',
        '{"type":"turn.started"}',
        '{"type":"message.completed","message":{"id":"msg_001","role":"assistant","content":"Hello!"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}',
      ].join('\n');
      const parsed = connector.testParseOutput(minimal, '');
      expect(parsed.text).toBe('Hello!');
      expect(parsed.isError).toBe(false);
      expect(parsed.inputTokens).toBe(10);
      expect(parsed.outputTokens).toBe(2);
    });
  });

  describe('parseOutput — error', () => {
    it('should detect error from JSONL error event', () => {
      const parsed = connector.testParseOutput(errorJsonl, stderrNoise);
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toContain('refresh token');
    });

    it('should detect error from turn.failed event', () => {
      const failedOnly = [
        '{"type":"thread.started","thread_id":"abc"}',
        '{"type":"turn.started"}',
        '{"type":"turn.failed","error":{"message":"Some fatal error"}}',
      ].join('\n');
      const parsed = connector.testParseOutput(failedOnly, '');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toBe('Some fatal error');
    });

    it('should handle empty stdout as error', () => {
      const parsed = connector.testParseOutput('', '');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toBe('No output');
    });

    it('should handle malformed JSONL gracefully', () => {
      const badJsonl = 'not json\n{"type":"thread.started","thread_id":"abc"}\nbroken{';
      const parsed = connector.testParseOutput(badJsonl, '');
      expect(parsed.isError).toBe(true);
    });

    it('should handle item.completed with type error as non-fatal warning', () => {
      // item.completed with type:"error" is a warning, not a fatal error
      const warningThenSuccess = [
        '{"type":"thread.started","thread_id":"abc"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata not found. Defaulting to fallback."}}',
        '{"type":"turn.started"}',
        '{"type":"message.completed","message":{"id":"msg_001","role":"assistant","content":"42"}}',
        '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":3,"total_tokens":53}}',
      ].join('\n');
      const parsed = connector.testParseOutput(warningThenSuccess, '');
      expect(parsed.text).toBe('42');
      expect(parsed.isError).toBe(false);
    });
  });

  describe('classifyError', () => {
    it('should classify refresh token errors as auth_error', () => {
      expect(connector.testClassifyError('refresh token has already been used', 0)).toBe(
        'auth_error',
      );
    });

    it('should classify expired token as auth_error', () => {
      expect(connector.testClassifyError('authentication token is expired', 0)).toBe('auth_error');
    });

    it('should classify sign in again as auth_error', () => {
      expect(connector.testClassifyError('Please log out and sign in again', 0)).toBe('auth_error');
    });

    it('should classify model metadata not found as model_not_found', () => {
      expect(connector.testClassifyError('Model metadata for `o4-mini` not found', 0)).toBe(
        'model_not_found',
      );
    });

    it('should classify rate limit errors', () => {
      expect(connector.testClassifyError('rate limit exceeded', 0)).toBe('rate_limited');
    });

    it('should fall back to base classification', () => {
      expect(connector.testClassifyError('', 127)).toBe('binary_not_found');
      expect(connector.testClassifyError('something unknown', 1)).toBe('execution_error');
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capability schema', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('codex');
      expect(caps.type).toBe('cli');
      expect(caps.models).toEqual(['o4-mini', 'o3', 'codex-mini-latest']);
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(false);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxTimeout).toBe(600_000);
    });
  });
});
