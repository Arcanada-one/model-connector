// AUP-CACHE-006 — policy evaluator: positive matrix (the CACHE-004 replay loop,
// prefix_hash equal to the Python oracle), negative matrix (refusal/mark in
// 100 % of cases in enforce/observe), tenant-scoped identity, pre-warm, and
// the latency budget (positive fixtures add < 20 ms p95).

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ActiveMode,
  InMemoryPolicyStore,
  PolicyContext,
  PromptCachePolicyDecision,
  actionOf,
  canonicalJson,
  evaluatePromptCachePolicy,
  verdictOf,
} from './prompt-cache-policy';
import { loadVendoredPromptLayoutContract } from './prompt-layout-contract';
import { buildReplayRequest, loadReplayFixture } from '../../test/prompt-cache/replay-fixture';

const contract = loadVendoredPromptLayoutContract();
const fixture = loadReplayFixture();

// What the Python reference (prefix_lint.py + replay_loop.py) computes for the
// replay fixture — vendored in prompt-assembly as replay-expectations.json.
const ORACLE = {
  prefix_hash: 'sha256:d4c2d0bc76c5ad0efa88dde4853233aaddf73d01b9413faf62c93f8c8de76c3c',
  layer_hashes: {
    L0: 'sha256:5b5b81b12a17b00284416510aa8b7e3d4683aca3ad61e569b8e46c9b3e5e16e4',
    L1: 'sha256:621f77c40aa1af0db6c29d616db5ed0ab0623e5cf4f60830050edf924a6d23c8',
    L2: 'sha256:a09525771eb1f632bd18261ccdc2a42ba7b43e1f4261b7710c3214cdfa4d2f8f',
    L3: 'sha256:a5796b83d622945f878b43de9ee3b9949d2b5ba2b03a206e073d7d05371460b2',
  },
  est_prefix_tokens: 1429,
};

let decisionCounter = 0;
function evaluate(
  body: unknown,
  ctx: PolicyContext,
  mode: ActiveMode,
  store: InMemoryPolicyStore,
): PromptCachePolicyDecision {
  decisionCounter += 1;
  return evaluatePromptCachePolicy(body, ctx, {
    contract,
    mode,
    store,
    decisionId: `d-${decisionCounter}`,
  });
}

function codes(decision: PromptCachePolicyDecision): string[] {
  return decision.findings.map((f) => f.code);
}

function errorCodes(decision: PromptCachePolicyDecision): string[] {
  return decision.findings
    .filter((f) => f.severity === 'error' || f.severity === 'refusal')
    .map((f) => f.code);
}

type Block = { type: string; text: string; cache_control?: unknown };

/** Append text to the block that closes system partition `n` (1-based: L1, L2, L3). */
function injectIntoSystemPartition(request: Record<string, unknown>, n: number, text: string) {
  const system = request.system as Block[];
  let closed = 0;
  for (const block of system) {
    if (block.cache_control !== undefined) {
      closed += 1;
      if (closed === n) {
        block.text += `\n${text}`;
        return request;
      }
    }
  }
  throw new Error(`system has fewer than ${n} partitions`);
}

const SECRET = 'mun_sk_' + 'NOT_A_REAL_KEY_FOR_THE_POLICY_SPEC_0000';
const tenantA: PolicyContext = { tenantId: 'key-A', sessionId: 'sess-1' };

describe('replay loop (positive matrix, parity with the Python oracle)', () => {
  it('keeps one prefix_hash over 10 steps, CONFORMANT, and matches the oracle hashes', () => {
    const store = new InMemoryPolicyStore();
    const decisions: PromptCachePolicyDecision[] = [];
    for (let step = 1; step <= 10; step += 1) {
      decisions.push(evaluate(buildReplayRequest(fixture, step), tenantA, 'enforce', store));
    }
    for (const decision of decisions) {
      expect(decision.caching_claimed).toBe(true);
      expect(decision.verdict).toBe('CONFORMANT');
      expect(decision.action).toBe('pass');
      expect(errorCodes(decision)).toEqual([]);
      expect(decision.prefix_hash).toBe(ORACLE.prefix_hash);
      expect(decision.layer_hashes).toEqual(ORACLE.layer_hashes);
      expect(decision.est_prefix_tokens).toBe(ORACLE.est_prefix_tokens);
      expect(decision.session.prefix_changed).toBe(false);
      expect(decision.model_resolved).not.toBeNull();
    }
    expect(decisions.map((d) => d.session.request_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(decisions[0].session.baseline).toBe('new');
    expect(decisions.slice(1).every((d) => d.session.baseline === 'kept')).toBe(true);
    // The sentinel sits in a tool result after the last breakpoint: a warning, never cached.
    const tailWarnings = decisions.flatMap((d) =>
      d.findings.filter((f) => f.code === 'SECRET_IN_TAIL'),
    );
    expect(tailWarnings.length).toBeGreaterThan(0);
    expect(tailWarnings.every((f) => f.severity === 'warning')).toBe(true);
    expect(decisions[0].cache_identity).not.toBe(decisions[0].prefix_hash);
  });

  it('canonical JSON matches Python json.dumps(sort_keys, compact, ensure_ascii=False)', () => {
    expect(canonicalJson({ b: [1, 'é', null, true], a: { z: 0.5, y: 'x' } })).toBe(
      '{"a":{"y":"x","z":0.5},"b":[1,"é",null,true]}',
    );
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
  });
});

interface NegativeCase {
  readonly name: string;
  readonly expect: string;
  readonly run: (mode: ActiveMode) => PromptCachePolicyDecision;
}

const NEGATIVE: NegativeCase[] = [
  {
    name: 'secret in L2',
    expect: 'SECRET_IN_PREFIX',
    run: (mode) =>
      evaluate(
        injectIntoSystemPartition(buildReplayRequest(fixture, 1), 2, `api_key = ${SECRET}`),
        tenantA,
        mode,
        new InMemoryPolicyStore(),
      ),
  },
  {
    name: 'tool-set change inside the session without session_epoch',
    expect: 'SESSION_TOOLS_CHANGED',
    run: (mode) => {
      const store = new InMemoryPolicyStore();
      evaluate(buildReplayRequest(fixture, 1), tenantA, mode, store);
      const second = buildReplayRequest(fixture, 2);
      (second.tools as unknown[]).push({
        name: 'late_tool',
        description: 'added mid-session',
        input_schema: { type: 'object', properties: {} },
      });
      return evaluate(second, tenantA, mode, store);
    },
  },
  {
    name: 'short prefix below the model minimum',
    expect: 'PREFIX_BELOW_MINIMUM',
    run: (mode) =>
      evaluate(
        {
          model: 'claude-fable-5-1',
          max_tokens: 64,
          system: [
            { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'Project: demo.', cache_control: { type: 'ephemeral' } },
          ],
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'contract: prompt-layout.v1',
                  cache_control: { type: 'ephemeral' },
                },
                { type: 'text', text: 'hello' },
              ],
            },
          ],
        },
        tenantA,
        mode,
        new InMemoryPolicyStore(),
      ),
  },
  {
    name: 'cross-tenant prefix (same bytes, another API key)',
    expect: 'CROSS_TENANT_PREFIX',
    run: (mode) => {
      const store = new InMemoryPolicyStore();
      evaluate(buildReplayRequest(fixture, 1), { tenantId: 'key-A', sessionId: 'a' }, mode, store);
      return evaluate(
        buildReplayRequest(fixture, 1),
        { tenantId: 'key-B', sessionId: 'b' },
        mode,
        store,
      );
    },
  },
  {
    name: 'session id owned by another tenant',
    expect: 'SESSION_TENANT_MISMATCH',
    run: (mode) => {
      const store = new InMemoryPolicyStore();
      evaluate(
        buildReplayRequest(fixture, 1),
        { tenantId: 'key-A', sessionId: 'shared' },
        mode,
        store,
      );
      return evaluate(
        buildReplayRequest(fixture, 1),
        { tenantId: 'key-B', sessionId: 'shared' },
        mode,
        store,
      );
    },
  },
  {
    name: 'tenant marker before the last breakpoint',
    expect: 'TENANT_IN_PREFIX',
    run: (mode) =>
      evaluate(
        injectIntoSystemPartition(buildReplayRequest(fixture, 1), 1, 'tenant: acme-industries'),
        tenantA,
        mode,
        new InMemoryPolicyStore(),
      ),
  },
  {
    name: 'model change inside the session without session_epoch',
    expect: 'SESSION_MODEL_CHANGED',
    run: (mode) => {
      const store = new InMemoryPolicyStore();
      evaluate(buildReplayRequest(fixture, 1), tenantA, mode, store);
      const second = buildReplayRequest(fixture, 2);
      second.model = 'claude-opus-5';
      return evaluate(second, tenantA, mode, store);
    },
  },
  {
    name: 'system (L1) change inside the session without session_epoch',
    expect: 'SESSION_SYSTEM_CHANGED',
    run: (mode) => {
      const store = new InMemoryPolicyStore();
      evaluate(buildReplayRequest(fixture, 1), tenantA, mode, store);
      return evaluate(buildReplayRequest(fixture, 2, 'Also: be terse.'), tenantA, mode, store);
    },
  },
  {
    name: 'history rewritten (not append-only)',
    expect: 'L4_NOT_APPEND_ONLY',
    run: (mode) => {
      const store = new InMemoryPolicyStore();
      evaluate(buildReplayRequest(fixture, 3), tenantA, mode, store);
      const rewritten = buildReplayRequest(fixture, 4);
      const messages = rewritten.messages as { content: Block[] }[];
      messages[1].content[0].text = 'edited history';
      return evaluate(rewritten, tenantA, mode, store);
    },
  },
  {
    name: 'same tools, different order',
    expect: 'TOOL_ORDER_NONDETERMINISTIC',
    run: (mode) => {
      const store = new InMemoryPolicyStore();
      evaluate(buildReplayRequest(fixture, 1), tenantA, mode, store);
      const second = buildReplayRequest(fixture, 2);
      (second.tools as unknown[]).reverse();
      return evaluate(second, tenantA, mode, store);
    },
  },
  {
    name: 'timestamp in L1 (dynamic content in the prefix)',
    expect: 'DYN_TIMESTAMP',
    run: (mode) =>
      evaluate(
        injectIntoSystemPartition(
          buildReplayRequest(fixture, 1),
          1,
          'generated_at: 2026-09-05T08:00',
        ),
        tenantA,
        mode,
        new InMemoryPolicyStore(),
      ),
  },
  {
    name: 'cache_control on a tool definition',
    expect: 'BREAKPOINT_MISPLACED',
    run: (mode) => {
      const request = buildReplayRequest(fixture, 1);
      (request.tools as Record<string, unknown>[])[0].cache_control = { type: 'ephemeral' };
      return evaluate(request, tenantA, mode, new InMemoryPolicyStore());
    },
  },
  {
    name: 'TTL order (5m before 1h)',
    expect: 'TTL_ORDER',
    run: (mode) => {
      const request = buildReplayRequest(fixture, 1);
      const system = request.system as Block[];
      const closers = system.filter((b) => b.cache_control !== undefined);
      closers[0].cache_control = { type: 'ephemeral', ttl: '5m' };
      closers[1].cache_control = { type: 'ephemeral', ttl: '1h' };
      return evaluate(request, tenantA, mode, new InMemoryPolicyStore());
    },
  },
  {
    name: 'system as a string (no breakpoints possible)',
    expect: 'SYSTEM_NOT_BLOCKS',
    run: (mode) => {
      const request = buildReplayRequest(fixture, 1);
      request.system = 'one big string';
      return evaluate(request, tenantA, mode, new InMemoryPolicyStore());
    },
  },
];

describe('negative fixture matrix: refusal in enforce, mark in observe, 100 %', () => {
  for (const mode of ['enforce', 'observe'] as const) {
    it(`${mode}: every negative fixture is a VIOLATION with the expected code`, () => {
      const results = NEGATIVE.map((c) => ({
        name: c.name,
        expect: c.expect,
        decision: c.run(mode),
      }));
      const wrong = results.filter(
        (r) =>
          r.decision.verdict !== 'VIOLATION' ||
          !codes(r.decision).includes(r.expect) ||
          r.decision.action !== (mode === 'enforce' ? 'refuse' : 'mark'),
      );
      expect(
        wrong.map(
          (r) =>
            `${r.name}: ${r.decision.verdict}/${r.decision.action} ${codes(r.decision).join(',')}`,
        ),
      ).toEqual([]);
      expect(results.length).toBe(NEGATIVE.length);
    });
  }

  it('findings never carry request text (a secret hit names the pattern index only)', () => {
    const decision = NEGATIVE[0].run('enforce');
    const serialised = JSON.stringify(decision);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain('NOT_A_REAL_KEY');
    const hit = decision.findings.find((f) => f.code === 'SECRET_IN_PREFIX');
    expect(hit?.severity).toBe('refusal');
    expect(hit?.layer).toBe('L2');
    expect(hit?.detail).toMatch(/pattern #\d+ of SECRET_IN_PREFIX matched in L2/);
  });

  it('a refused request never becomes the session baseline', () => {
    const store = new InMemoryPolicyStore();
    evaluate(buildReplayRequest(fixture, 1), tenantA, 'enforce', store);
    const changed = buildReplayRequest(fixture, 2);
    changed.model = 'claude-opus-5';
    expect(evaluate(changed, tenantA, 'enforce', store).action).toBe('refuse');
    // The conforming continuation still compares against the ORIGINAL baseline.
    const third = evaluate(buildReplayRequest(fixture, 2), tenantA, 'enforce', store);
    expect(third.verdict).toBe('CONFORMANT');
    expect(third.session.request_index).toBe(1);
  });
});

describe('session_epoch, pre-warm, undetermined and unclaimed requests', () => {
  it('an explicit session_epoch admits a tool-set change (new baseline, no code)', () => {
    const store = new InMemoryPolicyStore();
    evaluate(buildReplayRequest(fixture, 1), { ...tenantA, sessionEpoch: '1' }, 'enforce', store);
    const second = buildReplayRequest(fixture, 2);
    (second.tools as unknown[]).push({
      name: 'late_tool',
      description: 'added with an epoch',
      input_schema: { type: 'object', properties: {} },
    });
    const decision = evaluate(second, { ...tenantA, sessionEpoch: '2' }, 'enforce', store);
    expect(decision.verdict).toBe('CONFORMANT');
    expect(decision.session.baseline).toBe('epoch_advanced');
    expect(decision.session.epoch).toBe('2');
    expect(decision.session.prefix_changed).toBe(true);
    expect(decision.session.changed_layers).toEqual(['L0']);
  });

  it('a pre-warm (max_tokens 0, identical messages) is admitted and flagged', () => {
    const store = new InMemoryPolicyStore();
    evaluate(buildReplayRequest(fixture, 3), tenantA, 'enforce', store);
    const warm = buildReplayRequest(fixture, 3);
    warm.max_tokens = 0;
    const decision = evaluate(warm, tenantA, 'enforce', store);
    expect(decision.prewarm).toBe(true);
    expect(decision.verdict).toBe('CONFORMANT');
    expect(decision.action).toBe('pass');
  });

  it('an unknown model is UNDETERMINED: marked in both modes, refused in neither', () => {
    for (const mode of ['enforce', 'observe'] as const) {
      const request = buildReplayRequest(fixture, 1);
      request.model = 'claude-sonnet-4-5';
      const decision = evaluate(request, tenantA, mode, new InMemoryPolicyStore());
      expect(decision.verdict).toBe('UNDETERMINED');
      expect(decision.action).toBe('mark');
      expect(codes(decision)).toContain('MODEL_UNKNOWN');
      expect(decision.model_resolved).toBeNull();
    }
  });

  it('a request that claims no caching is NOT_CLAIMED, passes, and leaves no state', () => {
    const store = new InMemoryPolicyStore();
    const decision = evaluate(
      {
        model: 'claude-fable-5-1',
        max_tokens: 10,
        system: 'plain',
        messages: [{ role: 'user', content: 'hi' }],
      },
      tenantA,
      'enforce',
      store,
    );
    expect(decision.verdict).toBe('NOT_CLAIMED');
    expect(decision.action).toBe('pass');
    expect(decision.prefix_hash).toBeNull();
    expect(store.size).toEqual({ sessions: 0, prefixes: 0, sessionIds: 0 });
  });

  it('a claimed prefix_hash that differs from the bytes is held as a conflict, not resolved', () => {
    const decision = evaluate(
      buildReplayRequest(fixture, 1),
      { tenantId: 'key-A', prefixHashClaimed: 'sha256:0000' },
      'enforce',
      new InMemoryPolicyStore(),
    );
    expect(codes(decision)).toContain('PREFIX_HASH_CONFLICT');
    expect(decision.verdict).toBe('CONFORMANT');
    expect(decision.prefix_hash).toBe(ORACLE.prefix_hash);
  });

  it('an unattributed tenant is evaluated and warned, never silently attributed', () => {
    const decision = evaluate(
      buildReplayRequest(fixture, 1),
      { tenantId: null },
      'enforce',
      new InMemoryPolicyStore(),
    );
    expect(decision.tenant).toBe('unattributed');
    expect(codes(decision)).toContain('TENANT_UNATTRIBUTED');
    expect(decision.verdict).toBe('CONFORMANT');
  });

  it('an unreadable body is UNDETERMINED', () => {
    const decision = evaluate('not a body', tenantA, 'enforce', new InMemoryPolicyStore());
    expect(decision.verdict).toBe('UNDETERMINED');
    expect(decision.action).toBe('mark');
    expect(codes(decision)).toEqual(['REQUEST_UNREADABLE']);
  });

  it('verdict/action tables', () => {
    expect(verdictOf([])).toBe('CONFORMANT');
    expect(actionOf('enforce', 'VIOLATION')).toBe('refuse');
    expect(actionOf('observe', 'VIOLATION')).toBe('mark');
    expect(actionOf('enforce', 'UNDETERMINED')).toBe('mark');
    expect(actionOf('enforce', 'NOT_CLAIMED')).toBe('pass');
  });

  it('the in-memory store expires idle sessions and bounds owner maps', () => {
    const store = new InMemoryPolicyStore({ sessionIdleMs: 1000, maxSessions: 2, maxOwners: 2 });
    evaluatePromptCachePolicy(
      buildReplayRequest(fixture, 1),
      { tenantId: 't', sessionId: 's1' },
      { contract, mode: 'observe', store, decisionId: 'x1', nowMs: 0 },
    );
    evaluatePromptCachePolicy(
      buildReplayRequest(fixture, 1),
      { tenantId: 't', sessionId: 's2' },
      { contract, mode: 'observe', store, decisionId: 'x2', nowMs: 10 },
    );
    evaluatePromptCachePolicy(
      buildReplayRequest(fixture, 1),
      { tenantId: 't', sessionId: 's3' },
      { contract, mode: 'observe', store, decisionId: 'x3', nowMs: 5000 },
    );
    expect(store.size.sessions).toBeLessThanOrEqual(2);
    expect(store.size.sessionIds).toBeLessThanOrEqual(2);
    expect(store.sweepSessions(100_000)).toBeGreaterThanOrEqual(0);
    expect(store.size.sessions).toBe(0);
  });
});

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

describe('latency budget (positive fixtures add < 20 ms p95)', () => {
  it('measures 200 replay-loop evaluations and 20 rounds of the negative matrix', () => {
    const positive: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      const store = new InMemoryPolicyStore();
      for (let step = 1; step <= 10; step += 1) {
        const body = buildReplayRequest(fixture, step);
        const started = process.hrtime.bigint();
        evaluate(body, { tenantId: 'key-L', sessionId: `s-${round}` }, 'enforce', store);
        positive.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
    }
    const negative: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      for (const c of NEGATIVE) {
        const started = process.hrtime.bigint();
        c.run('enforce');
        negative.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
    }
    const sortedPositive = [...positive].sort((a, b) => a - b);
    const sortedNegative = [...negative].sort((a, b) => a - b);
    const report = {
      schema: 'PromptCachePolicyLatency/v1',
      node: process.version,
      positive: {
        n: positive.length,
        p50_ms: percentile(sortedPositive, 50),
        p95_ms: percentile(sortedPositive, 95),
        max_ms: sortedPositive[sortedPositive.length - 1],
        mean_ms: positive.reduce((a, b) => a + b, 0) / positive.length,
      },
      negative_including_setup: {
        n: negative.length,
        p50_ms: percentile(sortedNegative, 50),
        p95_ms: percentile(sortedNegative, 95),
        max_ms: sortedNegative[sortedNegative.length - 1],
      },
      budget_p95_ms: 20,
    };
    // Written to stdout so the receipt can quote the measured numbers verbatim.
    console.log(`PROMPT_CACHE_POLICY_LATENCY ${JSON.stringify(report)}`);
    const out = process.env.PROMPT_CACHE_LATENCY_OUT;
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
    expect(report.positive.p95_ms).toBeLessThan(20);
  });
});
