import { describe, it, expect } from 'vitest';
import { CursorConnector } from './cursor.connector';
import { ConnectorRequest } from '../interfaces/connector.interface';

// Expose protected methods for testing
class TestCursorConnector extends CursorConnector {
  public testBuildArgs(request: ConnectorRequest): string[] {
    return this.buildArgs(request);
  }

  public testParseOutput(stdout: string, stderr: string) {
    return this.parseOutput(stdout, stderr);
  }

  public testClassifyError(msg: string, code: number) {
    return this.classifyError(msg, code);
  }

  public testGetEnv() {
    return this.getEnv();
  }
}

describe('CursorConnector', () => {
  const connector = new TestCursorConnector();

  describe('buildArgs', () => {
    it('should build args for basic prompt (no agent subcommand — standalone binary)', () => {
      const args = connector.testBuildArgs({ prompt: 'hello' });
      expect(args).toEqual([
        '--print', '--output-format', 'json', '--force', 'hello',
      ]);
    });

    it('should include --model when model is specified', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', model: 'claude-4.6-opus-high' });
      expect(args).toContain('--model');
      expect(args).toContain('claude-4.6-opus-high');
      expect(args.indexOf('--model')).toBe(args.indexOf('claude-4.6-opus-high') - 1);
    });

    it('should include --workspace from extra', () => {
      const args = connector.testBuildArgs({
        prompt: 'hi',
        extra: { workspace: '/tmp' },
      });
      expect(args).toContain('--workspace');
      expect(args).toContain('/tmp');
    });

    it('should include --mode from extra', () => {
      const args = connector.testBuildArgs({
        prompt: 'hi',
        extra: { mode: 'plan' },
      });
      expect(args).toContain('--mode');
      expect(args).toContain('plan');
    });

    it('should prepend JSON instruction to prompt when responseFormat is json_object', () => {
      const args = connector.testBuildArgs({
        prompt: 'list items',
        responseFormat: { type: 'json_object' },
      });
      const prompt = args[args.length - 1];
      expect(prompt).toContain('valid JSON only');
      expect(prompt).toContain('list items');
    });

    it('should NOT modify prompt when responseFormat is text', () => {
      const args = connector.testBuildArgs({
        prompt: 'hello',
        responseFormat: { type: 'text' },
      });
      expect(args[args.length - 1]).toBe('hello');
    });
  });

  describe('parseOutput', () => {
    // Fixture from CONN-0002-fixtures.md §2
    const successFixture = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 8689,
      duration_api_ms: 8689,
      result: '4',
      session_id: '4654fd9e-79c1-4826-8a65-aa9480f13d7d',
      request_id: '2ddef593-e818-4e9e-bfa5-ab71a25b28e2',
    });

    it('should parse success JSON output', () => {
      const parsed = connector.testParseOutput(successFixture, '');
      expect(parsed.text).toBe('4');
      expect(parsed.isError).toBe(false);
      expect(parsed.model).toBe('cursor-auto');
      expect(parsed.inputTokens).toBe(0);
      expect(parsed.outputTokens).toBe(0);
      expect(parsed.costUsd).toBe(0);
      expect(parsed.structured).toMatchObject({
        sessionId: '4654fd9e-79c1-4826-8a65-aa9480f13d7d',
        requestId: '2ddef593-e818-4e9e-bfa5-ab71a25b28e2',
        durationMs: 8689,
      });
    });

    it('should handle empty stdout with error stderr', () => {
      const parsed = connector.testParseOutput('', 'Authentication required');
      expect(parsed.text).toBe('');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toBe('Authentication required');
    });

    it('should handle malformed stdout', () => {
      const parsed = connector.testParseOutput('not json at all', '');
      expect(parsed.text).toBe('not json at all');
      expect(parsed.isError).toBe(true);
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capability schema', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('cursor');
      expect(caps.type).toBe('cli');
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(false);
      expect(caps.supportsTools).toBe(true);
      expect(caps.models).toContain('auto');
      expect(caps.maxTimeout).toBeGreaterThan(0);
    });
  });

  describe('getEnv', () => {
    it('should pass CURSOR_API_KEY when set', () => {
      process.env.CURSOR_API_KEY = 'test-key-123';
      const env = connector.testGetEnv();
      expect(env).toEqual({ CURSOR_API_KEY: 'test-key-123' });
      delete process.env.CURSOR_API_KEY;
    });

    it('should return empty object when CURSOR_API_KEY not set', () => {
      delete process.env.CURSOR_API_KEY;
      const env = connector.testGetEnv();
      expect(env).toEqual({});
    });
  });

  describe('classifyError', () => {
    it('should classify Cursor auth errors', () => {
      expect(connector.testClassifyError('Authentication required', 1)).toBe('auth_error');
      expect(connector.testClassifyError('The provided API key is invalid', 1)).toBe('auth_error');
    });

    it('should inherit base classifications', () => {
      expect(connector.testClassifyError('rate limit exceeded', 1)).toBe('rate_limited');
      expect(connector.testClassifyError('', 127)).toBe('binary_not_found');
    });
  });
});
