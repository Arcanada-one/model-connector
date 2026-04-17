import { describe, it, expect, vi } from 'vitest';
import { BaseCliConnector, ParsedCliOutput } from './base-cli.connector';
import { ConnectorCapabilities, ConnectorRequest } from './interfaces/connector.interface';

class TestConnector extends BaseCliConnector {
  name = 'test';

  protected getBinaryPath() {
    return '/usr/bin/echo';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    return [request.prompt];
  }

  protected parseOutput(stdout: string): ParsedCliOutput {
    return {
      text: stdout.trim(),
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.001,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'test',
      type: 'cli',
      models: ['test-model'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }

  // Expose for testing
  public testClassifyError(msg: string, code: number) {
    return this.classifyError(msg, code);
  }
}

describe('BaseCliConnector', () => {
  const connector = new TestConnector();

  it('should classify rate limit errors', () => {
    expect(connector.testClassifyError('rate limit exceeded', 1)).toBe('rate_limited');
    expect(connector.testClassifyError('server overloaded', 1)).toBe('rate_limited');
    expect(connector.testClassifyError('HTTP 429', 1)).toBe('rate_limited');
  });

  it('should classify auth errors', () => {
    expect(connector.testClassifyError('Not logged in', 1)).toBe('auth_error');
    expect(connector.testClassifyError('unauthorized', 1)).toBe('auth_error');
  });

  it('should classify binary not found (exit 127)', () => {
    expect(connector.testClassifyError('', 127)).toBe('binary_not_found');
  });

  it('should hash prompts with SHA-256', () => {
    const hash = BaseCliConnector.hashPrompt('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toBe(BaseCliConnector.hashPrompt('hello'));
    expect(hash).not.toBe(BaseCliConnector.hashPrompt('world'));
  });
});
