import { describe, it, expect } from 'vitest';
import { ClaudeCodeConnector } from './claude-code.connector';
import { ConnectorRequest } from '../interfaces/connector.interface';

// Expose protected methods for testing
class TestClaudeCodeConnector extends ClaudeCodeConnector {
  public testBuildArgs(request: ConnectorRequest): string[] {
    return this.buildArgs(request);
  }

  public testParseOutput(stdout: string, stderr: string) {
    return this.parseOutput(stdout, stderr);
  }

  public testClassifyError(msg: string, code: number) {
    return this.classifyError(msg, code);
  }

  public testGetEnv(request: ConnectorRequest) {
    return this.getEnv(request);
  }
}

// Live fixtures from CONN-0003-fixtures.md (Claude Code v2.1.98)
const successFixture = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1758,
  duration_api_ms: 1669,
  num_turns: 1,
  result: 'hello',
  stop_reason: 'end_turn',
  session_id: '9a62d284-12b3-4914-9b39-c29d38b70ce8',
  total_cost_usd: 0.10102275000000001,
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 26921,
    cache_read_input_tokens: 0,
    output_tokens: 4,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 26921 },
    inference_geo: '',
    iterations: [],
    speed: 'standard',
  },
  modelUsage: {
    'claude-sonnet-4-6': {
      inputTokens: 3,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 26921,
      webSearchRequests: 0,
      costUSD: 0.10102275000000001,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  permission_denials: [],
  terminal_reason: 'completed',
  fast_mode_state: 'off',
  uuid: 'cb46c417-0865-4bcb-ad62-80db1640cae5',
});

const errorMaxTurnsFixture = JSON.stringify({
  type: 'result',
  subtype: 'error_max_turns',
  duration_ms: 5289,
  duration_api_ms: 3512,
  is_error: true,
  num_turns: 2,
  stop_reason: 'tool_use',
  session_id: '95b3f45a-b38c-411c-a3de-9ac17e3169d8',
  total_cost_usd: 0.10266149999999999,
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 26930,
    cache_read_input_tokens: 0,
    output_tokens: 111,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 26930 },
    inference_geo: '',
    iterations: [],
    speed: 'standard',
  },
  modelUsage: {
    'claude-sonnet-4-6': {
      inputTokens: 3,
      outputTokens: 111,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 26930,
      webSearchRequests: 0,
      costUSD: 0.10266149999999999,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  permission_denials: [],
  terminal_reason: 'max_turns',
  fast_mode_state: 'off',
  uuid: '6522dc92-74be-41ff-a83b-33f4ded1fb24',
  errors: ['Reached maximum number of turns (1)'],
});

describe('ClaudeCodeConnector', () => {
  const connector = new TestClaudeCodeConnector();

  // --- buildArgs tests (T1-T10) ---

  describe('buildArgs', () => {
    it('should build args for basic prompt with mandatory flags', () => {
      const args = connector.testBuildArgs({ prompt: 'hello' });
      expect(args).toEqual([
        '-p', '--output-format', 'json',
        '--permission-mode', 'bypassPermissions',
        'hello',
      ]);
    });

    it('should include --model when model is specified', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', model: 'sonnet' });
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
      expect(args.indexOf('--model')).toBe(args.indexOf('sonnet') - 1);
    });

    it('should include --system-prompt when systemPrompt is specified', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', systemPrompt: 'Be brief' });
      expect(args).toContain('--system-prompt');
      expect(args).toContain('Be brief');
    });

    it('should include --max-turns when maxTurns is specified', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', maxTurns: 5 });
      expect(args).toContain('--max-turns');
      expect(args).toContain('5');
    });

    it('should include --max-budget-usd when maxBudgetUsd is specified', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', maxBudgetUsd: 1.5 });
      expect(args).toContain('--max-budget-usd');
      expect(args).toContain('1.5');
    });

    it('should include --json-schema when jsonSchema is specified', () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };
      const args = connector.testBuildArgs({ prompt: 'hi', jsonSchema: schema });
      expect(args).toContain('--json-schema');
      expect(args).toContain(JSON.stringify(schema));
    });

    it('should include --allowed-tools from extra', () => {
      const args = connector.testBuildArgs({
        prompt: 'hi',
        extra: { allowedTools: 'Bash,Read,Edit' },
      });
      expect(args).toContain('--allowed-tools');
      expect(args).toContain('Bash,Read,Edit');
    });

    it('should override permission mode from extra', () => {
      const args = connector.testBuildArgs({
        prompt: 'hi',
        extra: { permissionMode: 'acceptEdits' },
      });
      expect(args).toContain('--permission-mode');
      expect(args).toContain('acceptEdits');
      expect(args).not.toContain('bypassPermissions');
    });

    it('should include --effort when effort is specified', () => {
      const args = connector.testBuildArgs({ prompt: 'hi', effort: 'high' });
      expect(args).toContain('--effort');
      expect(args).toContain('high');
    });

    it('should always place prompt as last argument', () => {
      const args = connector.testBuildArgs({
        prompt: 'my prompt',
        model: 'opus',
        effort: 'high',
        maxTurns: 3,
      });
      expect(args[args.length - 1]).toBe('my prompt');
    });

    it('should prepend JSON instruction to system prompt when responseFormat is json_object', () => {
      const args = connector.testBuildArgs({
        prompt: 'list users',
        responseFormat: { type: 'json_object' },
      });
      expect(args).toContain('--system-prompt');
      const spIdx = args.indexOf('--system-prompt');
      expect(args[spIdx + 1]).toContain('valid JSON only');
    });

    it('should merge JSON instruction with existing systemPrompt when responseFormat is json_object', () => {
      const args = connector.testBuildArgs({
        prompt: 'list users',
        systemPrompt: 'Be concise',
        responseFormat: { type: 'json_object' },
      });
      const spIdx = args.indexOf('--system-prompt');
      expect(args[spIdx + 1]).toContain('valid JSON only');
      expect(args[spIdx + 1]).toContain('Be concise');
    });

    it('should NOT add JSON instruction when jsonSchema is present (jsonSchema takes priority)', () => {
      const args = connector.testBuildArgs({
        prompt: 'list users',
        jsonSchema: { type: 'object' },
        responseFormat: { type: 'json_object' },
      });
      const spIdx = args.indexOf('--system-prompt');
      expect(spIdx).toBe(-1); // no system prompt added
      expect(args).toContain('--json-schema'); // jsonSchema still works
    });
  });

  // --- parseOutput tests (T11-T15) ---

  describe('parseOutput', () => {
    it('should parse success fixture correctly', () => {
      const parsed = connector.testParseOutput(successFixture, '');
      expect(parsed.text).toBe('hello');
      expect(parsed.isError).toBe(false);
      expect(parsed.inputTokens).toBe(3);
      expect(parsed.outputTokens).toBe(4);
      expect(parsed.costUsd).toBeCloseTo(0.101, 2);
      expect(parsed.model).toBe('claude-sonnet-4-6');
      expect(parsed.structured).toMatchObject({
        sessionId: '9a62d284-12b3-4914-9b39-c29d38b70ce8',
        uuid: 'cb46c417-0865-4bcb-ad62-80db1640cae5',
        numTurns: 1,
        durationMs: 1758,
        stopReason: 'end_turn',
      });
    });

    it('should parse error_max_turns fixture correctly', () => {
      const parsed = connector.testParseOutput(errorMaxTurnsFixture, '');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toContain('maximum number of turns');
      expect(parsed.errorType).toBe('max_turns_exceeded');
      expect(parsed.inputTokens).toBe(3);
      expect(parsed.outputTokens).toBe(111);
      expect(parsed.costUsd).toBeCloseTo(0.103, 2);
      expect(parsed.text).toBe('');
    });

    it('should handle empty stdout as error', () => {
      const parsed = connector.testParseOutput('', 'Some stderr output');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toBe('Some stderr output');
      expect(parsed.text).toBe('');
    });

    it('should handle non-JSON stdout as error', () => {
      const parsed = connector.testParseOutput('Welcome to Claude Code!', '');
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toContain('parse');
    });

    it('should extract structured_output when present', () => {
      const fixture = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 100,
        duration_api_ms: 90,
        num_turns: 1,
        result: '{"name":"test"}',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        structured_output: { name: 'test' },
        session_id: 'sid',
        uuid: 'uid',
      });
      const parsed = connector.testParseOutput(fixture, '');
      expect(parsed.structured).toMatchObject({ structuredOutput: { name: 'test' } });
    });
  });

  // --- classifyError tests (T16-T20) ---

  describe('classifyError', () => {
    it('should classify billing_error', () => {
      expect(connector.testClassifyError('billing_error: account suspended', 1)).toBe('billing_error');
      expect(connector.testClassifyError('Insufficient credit balance', 1)).toBe('billing_error');
    });

    it('should classify authentication_failed', () => {
      expect(connector.testClassifyError('authentication_failed', 1)).toBe('auth_error');
    });

    it('should classify max_output_tokens', () => {
      expect(connector.testClassifyError('max_output_tokens reached', 1)).toBe('max_output_tokens');
    });

    it('should inherit base rate_limit classification', () => {
      expect(connector.testClassifyError('rate limit exceeded', 1)).toBe('rate_limited');
    });

    it('should inherit base binary_not_found (exit 127)', () => {
      expect(connector.testClassifyError('', 127)).toBe('binary_not_found');
    });
  });

  // --- getCapabilities test (T21) ---

  describe('getCapabilities', () => {
    it('should return correct capability schema', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('claude-code');
      expect(caps.type).toBe('cli');
      expect(caps.supportsJsonSchema).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.models).toContain('claude-sonnet-4-6');
      expect(caps.models).toContain('claude-opus-4-6');
      expect(caps.maxTimeout).toBeGreaterThan(0);
    });
  });

  // --- CONN-0025: exit code vs parsed result priority ---

  describe('exit code handling (CONN-0025)', () => {
    it('should return success when CLI produces valid JSON with is_error:false despite exit code 1', async () => {
      const c = new TestClaudeCodeConnector();
      c.setSemaphore(1);
      // Simulate: CLI returns valid success JSON but exits with code 1
      (c as any).spawnProcess = async () => ({
        stdout: successFixture,
        stderr: 'success',
        exitCode: 1,
      });

      const result = await c.execute({
        prompt: 'Return JSON',
        model: 'haiku',
        maxTurns: 1,
        responseFormat: { type: 'json_object' },
      });

      expect(result.status).toBe('success');
      expect(result.result).toBe('hello');
      expect(result.error).toBeUndefined();
    });
  });

  // --- getEnv test ---

  describe('getEnv', () => {
    it('should pass ANTHROPIC_API_KEY from extra.apiKey', () => {
      const env = connector.testGetEnv({ prompt: 'hi', extra: { apiKey: 'sk-test-123' } });
      expect(env).toHaveProperty('ANTHROPIC_API_KEY', 'sk-test-123');
    });

    it('should return empty env when no apiKey', () => {
      const env = connector.testGetEnv({ prompt: 'hi' });
      expect(env).toEqual({});
    });
  });
});
