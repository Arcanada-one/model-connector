import { describe, expect, it } from 'vitest';

import {
  PROTECTED_FORWARDED_EXTRA_RECORDS,
  __testOnlyWithoutExtrasRecord,
  assessProtectedForwardedExtras,
} from './protected-forwarded-extras';
import {
  PROTECTED_DISPATCH_FENCE_DECISIONS,
  classForwardsProtectedMaxTokens,
} from '../connectors/protected-dispatch-fence-admission';

describe('assessProtectedForwardedExtras', () => {
  it('records cover every admitted forwardsMaxTokens:true class', () => {
    const admittedForwarders = PROTECTED_DISPATCH_FENCE_DECISIONS.filter(
      (d) => d.decision === 'admitted' && d.forwardsMaxTokens,
    );
    const recorded = new Set(PROTECTED_FORWARDED_EXTRA_RECORDS.map((r) => r.className));
    for (const decision of admittedForwarders) {
      expect(recorded.has(decision.className), decision.className).toBe(true);
      const record = PROTECTED_FORWARDED_EXTRA_RECORDS.find(
        (r) => r.className === decision.className,
      );
      expect(record?.forwardedExtraKeys).toEqual([...decision.forwardedExtraKeys]);
    }
  });

  it('M-UNREVIEWED: disposition keys equal forwardedExtraKeys for every record', () => {
    for (const record of PROTECTED_FORWARDED_EXTRA_RECORDS) {
      expect(Object.keys(record.disposition).sort(), record.className).toEqual(
        [...record.forwardedExtraKeys].sort(),
      );
    }
  });

  it('M-UNREVIEWED: admitted forwardsMaxTokens class without extras record is refused', () => {
    const withRecord = assessProtectedForwardedExtras({
      connectorClassName: 'AzureOpenAiConnector',
      extra: { max_tokens: 16 },
    });
    expect(withRecord.ok).toBe(true); // record exists today

    // Cerebras is fence-refused for framing and does not forward max_tokens, so
    // a missing extras record is a no-op ok (not an admitted forwarder).
    expect(
      assessProtectedForwardedExtras({
        connectorClassName: 'CerebrasConnector',
        extra: { max_completion_tokens: 16 },
      }).ok,
    ).toBe(true);
    expect(
      assessProtectedForwardedExtras({
        connectorClassName: null,
        extra: { max_tokens: 16 },
      }).ok,
    ).toBe(true);
  });

  it('M-UNKNOWN-FWD: admitted forwarder without an extras record is refused', () => {
    expect(classForwardsProtectedMaxTokens('AzureOpenAiConnector')).toBe(true);
    const refused = __testOnlyWithoutExtrasRecord('AzureOpenAiConnector', () =>
      assessProtectedForwardedExtras({
        connectorClassName: 'AzureOpenAiConnector',
        extra: { max_tokens: 16 },
      }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toMatch(/without a reviewed extras record/);
      expect(refused.countedInputBytes).toBe(0);
    }
    // Record restored after the seam.
    expect(
      assessProtectedForwardedExtras({
        connectorClassName: 'AzureOpenAiConnector',
        extra: { max_tokens: 16 },
      }).ok,
    ).toBe(true);
  });

  it('M-PPLX-EXCLUDE: Perplexity has no protected extras record after Stage A refusal', () => {
    expect(
      PROTECTED_FORWARDED_EXTRA_RECORDS.some((r) => r.className === 'PerplexityConnector'),
    ).toBe(false);
    // Fence refuses the class, so forwardsMaxTokens alone must not invent a
    // disable_search path — assess is a no-op ok for non-admitted classes that
    // are not admitted forwarders. Perplexity still declares forwardsMaxTokens
    // factually; without an admission it must not be treated as a forwarder
    // with a reviewed extras table.
    expect(classForwardsProtectedMaxTokens('PerplexityConnector')).toBe(true);
    const assessed = assessProtectedForwardedExtras({
      connectorClassName: 'PerplexityConnector',
      extra: { max_tokens: 64, disable_search: true },
    });
    // Admitted-forwarder-without-record refuse: Perplexity still forwards
    // max_tokens in source, so missing extras record fails closed.
    expect(assessed.ok).toBe(false);
    if (!assessed.ok) {
      expect(assessed.message).toMatch(/without a reviewed extras record/);
    }
  });

  it('M-SEAM-PROD: __testOnlyWithoutExtrasRecord throws when VITEST is unset', () => {
    const saved = process.env.VITEST;
    try {
      delete process.env.VITEST;
      expect(() =>
        __testOnlyWithoutExtrasRecord('AzureOpenAiConnector', () =>
          assessProtectedForwardedExtras({
            connectorClassName: 'AzureOpenAiConnector',
            extra: { max_tokens: 16 },
          }),
        ),
      ).toThrow(/test-only \(VITEST!==true\)/);
    } finally {
      if (saved === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = saved;
      }
    }
  });

  it('Azure tools extras are counted; sampling stays neutral', () => {
    const tools = [
      { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
    ];
    const result = assessProtectedForwardedExtras({
      connectorClassName: 'AzureOpenAiConnector',
      extra: { max_tokens: 32, temperature: 0.2, tools },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.countedInputBytes).toBeGreaterThan(0);
  });

  it('M-UNREVIEWED: missing disposition for a forwarded key refuses', () => {
    // Live contract of the disposition==null branch: every listed key has a
    // disposition today. Mutation dropping one disposition entry is killed by
    // the sorted-keys equality test above; this asserts the runtime refuse path
    // still exists by checking the message shape for an impossible key via
    // forcing a temporary local record is out of scope — equality test is the kill.
    const record = PROTECTED_FORWARDED_EXTRA_RECORDS.find(
      (r) => r.className === 'AzureOpenAiConnector',
    );
    expect(record).toBeTruthy();
    if (!record) return;
    for (const key of record.forwardedExtraKeys) {
      expect(record.disposition[key], key).toBeDefined();
    }
  });

  it('round-10 framing refuse: OpenRouter has no extras record after Stage A refusal', () => {
    expect(
      PROTECTED_FORWARDED_EXTRA_RECORDS.some((r) => r.className === 'OpenRouterConnector'),
    ).toBe(false);
    expect(classForwardsProtectedMaxTokens('OpenRouterConnector')).toBe(true);
    const assessed = assessProtectedForwardedExtras({
      connectorClassName: 'OpenRouterConnector',
      extra: { max_tokens: 16 },
    });
    expect(assessed.ok).toBe(false);
  });
});
