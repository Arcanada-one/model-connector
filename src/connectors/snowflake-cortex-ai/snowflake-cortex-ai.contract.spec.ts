import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as contract from './snowflake-cortex-ai.contract';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/chat-completion.success.json'), 'utf8'),
) as unknown;

const validRequest = () => ({
  accountUrl: 'https://acme-test.snowflakecomputing.com',
  model: 'synthetic-model',
  messages: [{ role: 'user', content: 'synthetic prompt' }],
});

const validFailure = (status: number) => ({ kind: 'http', status });

function expectContractError(action: () => unknown, absentText?: string): void {
  try {
    action();
    throw new Error('expected contract validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(contract.SnowflakeCortexContractError);
    if (absentText) expect(String(error)).not.toContain(absentText);
  }
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => isDeepFrozen(item, seen));
}

describe('Snowflake Cortex AI dormant contract', () => {
  it('exports only the frozen contract surface', () => {
    expect(Object.keys(contract).sort()).toEqual(
      [
        'SNOWFLAKE_CORTEX_LIMITS',
        'SnowflakeCortexContractError',
        'buildSnowflakeCortexChatDescriptor',
        'normalizeSnowflakeCortexFailure',
        'parseSnowflakeCortexChatResponse',
      ].sort(),
    );
  });

  describe('request descriptor', () => {
    it('builds the exact non-secret, one-attempt descriptor', () => {
      const result = contract.buildSnowflakeCortexChatDescriptor(validRequest());

      expect(result).toEqual({
        kind: 'snowflake-cortex-chat-completions-offline-descriptor',
        performsIo: false,
        authorizationOwner: 'caller',
        method: 'POST',
        url: 'https://acme-test.snowflakecomputing.com/api/v2/cortex/v1/chat/completions',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: {
          model: 'synthetic-model',
          messages: [{ role: 'user', content: 'synthetic prompt' }],
          stream: false,
        },
        timeoutMs: 30_000,
        maxAttempts: 1,
      });
      expect(JSON.stringify(result)).not.toContain('Authorization');
      expect(isDeepFrozen(result)).toBe(true);
    });

    it('maps only the documented optional fields and local timeout', () => {
      const result = contract.buildSnowflakeCortexChatDescriptor({
        ...validRequest(),
        maxCompletionTokens: 321,
        temperature: 0.25,
        topP: 0.8,
        timeoutMs: 5_000,
      });

      expect(result.body).toEqual({
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'synthetic prompt' }],
        stream: false,
        max_completion_tokens: 321,
        temperature: 0.25,
        top_p: 0.8,
      });
      expect(result.timeoutMs).toBe(5_000);
    });

    it('detaches and freezes all output', () => {
      const input = validRequest();
      const result = contract.buildSnowflakeCortexChatDescriptor(input);
      input.messages[0].content = 'mutated';
      expect(result.body.messages[0].content).toBe('synthetic prompt');
      expect(isDeepFrozen(result)).toBe(true);
    });

    it.each([
      ['missing account URL', { model: 'm', messages: [{ role: 'user', content: 'x' }] }],
      ['extra key', { ...validRequest(), version: 'v2' }],
      ['unsupported streaming', { ...validRequest(), stream: true }],
      ['unsupported tools', { ...validRequest(), tools: [] }],
      ['database scope', { ...validRequest(), database: 'DB' }],
      ['empty model', { ...validRequest(), model: '' }],
      ['extra message key', { ...validRequest(), messages: [{ role: 'user', content: 'x', name: 'n' }] }],
      ['wrong role', { ...validRequest(), messages: [{ role: 'tool', content: 'x' }] }],
      ['empty messages', { ...validRequest(), messages: [] }],
      ['deprecated max tokens', { ...validRequest(), max_tokens: 1 }],
      ['bad max completion tokens', { ...validRequest(), maxCompletionTokens: 0 }],
      ['bad temperature', { ...validRequest(), temperature: 2.01 }],
      ['bad top-p', { ...validRequest(), topP: -0.01 }],
      ['bad timeout', { ...validRequest(), timeoutMs: 999 }],
    ])('rejects %s', (_name, input) => {
      expectContractError(() => contract.buildSnowflakeCortexChatDescriptor(input));
    });

    it.each([
      'http://acme-test.snowflakecomputing.com',
      'https://snowflakecomputing.com',
      'https://acme-test.snowflakecomputing.com.attacker.invalid',
      'https://user@acme-test.snowflakecomputing.com',
      'https://acme-test.snowflakecomputing.com:8443',
      'https://acme-test.snowflakecomputing.com/not-root',
      'https://acme-test.snowflakecomputing.com/?query=yes',
      'https://acme-test.snowflakecomputing.com/#fragment',
      'https://127.0.0.1',
    ])('rejects unsafe account URL %s', (accountUrl) => {
      expectContractError(() =>
        contract.buildSnowflakeCortexChatDescriptor({ ...validRequest(), accountUrl }),
      );
    });

    it('enforces message count and UTF-8/string/request byte ceilings', () => {
      expectContractError(() =>
        contract.buildSnowflakeCortexChatDescriptor({
          ...validRequest(),
          messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })),
        }),
      );
      expectContractError(() =>
        contract.buildSnowflakeCortexChatDescriptor({
          ...validRequest(),
          messages: [{ role: 'user', content: '£'.repeat(16_385) }],
        }),
      );
      expectContractError(() =>
        contract.buildSnowflakeCortexChatDescriptor({
          ...validRequest(),
          messages: Array.from({ length: 10 }, () => ({ role: 'user', content: 'x'.repeat(30_000) })),
        }),
      );
    });
  });

  describe('safe unknown-value handling', () => {
    it('rejects accessors without evaluating them', () => {
      let reads = 0;
      const input = validRequest() as Record<string, unknown>;
      Object.defineProperty(input, 'model', {
        enumerable: true,
        get() {
          reads += 1;
          return 'synthetic-model';
        },
      });
      expectContractError(() => contract.buildSnowflakeCortexChatDescriptor(input));
      expect(reads).toBe(0);
    });

    it('rejects exotic prototypes and pollution keys', () => {
      const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
      Object.assign(exotic, validRequest());
      expectContractError(() => contract.buildSnowflakeCortexChatDescriptor(exotic));

      const polluted = Object.create(null) as Record<string, unknown>;
      Object.assign(polluted, validRequest());
      Object.defineProperty(polluted, '__proto__', {
        enumerable: true,
        value: 'pollution-attempt',
      });
      expectContractError(() => contract.buildSnowflakeCortexChatDescriptor(polluted));
    });

    it('rejects cyclic, overly deep, overly wide and sparse values', () => {
      const cyclic = validRequest() as Record<string, unknown>;
      cyclic.self = cyclic;
      expectContractError(() => contract.buildSnowflakeCortexChatDescriptor(cyclic));

      let deep: Record<string, unknown> = {};
      const root = deep;
      for (let index = 0; index < 9; index += 1) {
        deep.next = {};
        deep = deep.next as Record<string, unknown>;
      }
      expectContractError(() => contract.parseSnowflakeCortexChatResponse(root));

      const wide = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, index]));
      expectContractError(() => contract.parseSnowflakeCortexChatResponse(wide));

      const sparse = new Array(2);
      sparse[1] = { role: 'user', content: 'x' };
      expectContractError(() =>
        contract.buildSnowflakeCortexChatDescriptor({ ...validRequest(), messages: sparse }),
      );
    });
  });

  describe('response parser', () => {
    it('parses the synthetic common text response into a frozen detached copy', () => {
      const source = structuredClone(fixture) as {
        choices: Array<{ message: { content: string } }>;
      };
      const result = contract.parseSnowflakeCortexChatResponse(source);
      source.choices[0].message.content = 'mutated';
      expect(result).toEqual(fixture);
      expect(result.choices[0].message.content).toBe('synthetic response');
      expect(isDeepFrozen(result)).toBe(true);
    });

    it.each([
      ['extra root key', { ...(fixture as object), system_fingerprint: 'x' }],
      ['wrong object version', { ...(fixture as object), object: 'response' }],
      ['empty choices', { ...(fixture as object), choices: [] }],
      [
        'extra choice key',
        {
          ...(fixture as object),
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'x' },
              finish_reason: 'stop',
              tool_calls: [],
            },
          ],
        },
      ],
      [
        'non-text message',
        {
          ...(fixture as object),
          choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
        },
      ],
      [
        'inconsistent usage',
        {
          ...(fixture as object),
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 99 },
        },
      ],
    ])('rejects %s', (_name, input) => {
      expectContractError(() => contract.parseSnowflakeCortexChatResponse(input));
    });

    it('enforces the response byte ceiling', () => {
      const oversized = structuredClone(fixture) as {
        choices: Array<{ message: { content: string } }>;
      };
      oversized.choices[0].message.content = 'x'.repeat(1_048_577);
      expectContractError(() => contract.parseSnowflakeCortexChatResponse(oversized));
    });
  });

  describe('failure normalization and redaction', () => {
    it.each([
      [400, 'BAD_REQUEST'],
      [402, 'BUDGET_EXCEEDED'],
      [403, 'FORBIDDEN'],
      [429, 'QUOTA_EXCEEDED'],
      [503, 'TIMEOUT'],
      [418, 'HTTP_ERROR'],
    ])('maps HTTP %i to %s with no retry', (status, code) => {
      expect(contract.normalizeSnowflakeCortexFailure(validFailure(status))).toEqual({
        kind: 'snowflake-cortex-chat-failure',
        code,
        message: expect.any(String),
        retryable: false,
        status,
      });
    });

    it('normalizes local timeout and transport failures without raw details', () => {
      expect(contract.normalizeSnowflakeCortexFailure({ kind: 'timeout', timeoutMs: 5_000 })).toEqual({
        kind: 'snowflake-cortex-chat-failure',
        code: 'TIMEOUT',
        message: 'The caller-reported operation timed out.',
        retryable: false,
        timeoutMs: 5_000,
      });
      expect(contract.normalizeSnowflakeCortexFailure({ kind: 'transport' })).toEqual({
        kind: 'snowflake-cortex-chat-failure',
        code: 'TRANSPORT_ERROR',
        message: 'The caller-reported transport failed.',
        retryable: false,
      });
    });

    it('rejects secret-bearing or raw provider details without echoing them', () => {
      const secret = 'snowflake-secret-must-not-appear';
      expectContractError(
        () => contract.normalizeSnowflakeCortexFailure({ kind: 'http', status: 403, body: secret }),
        secret,
      );
      expectContractError(
        () => contract.normalizeSnowflakeCortexFailure({ kind: 'transport', cause: new Error(secret) }),
        secret,
      );
    });
  });

  it('contains no transport, runtime registration, secret or SQL behavior', () => {
    const source = readFileSync(join(__dirname, 'snowflake-cortex-ai.contract.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"](?:node:)?(?:http|https|net|dns|tls|dgram|child_process|fs)['"]/u);
    expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|process\.env|Authorization)\b/u);
    expect(source).not.toMatch(/\b(?:SELECT|SHOW|AI_COMPLETE|agent:run|inference:complete)\b/u);
  });
});
