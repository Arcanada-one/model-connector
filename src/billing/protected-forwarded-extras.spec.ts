import { describe, expect, it } from 'vitest';

import {
  PROTECTED_FORWARDED_EXTRA_RECORDS,
  assessProtectedForwardedExtras,
} from './protected-forwarded-extras';
import { PROTECTED_DISPATCH_FENCE_DECISIONS } from '../connectors/protected-dispatch-fence-admission';

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

  it('M-PPLXSEARCH: refuses Perplexity without disable_search or with web_search_options', () => {
    expect(
      assessProtectedForwardedExtras({
        connectorClassName: 'PerplexityConnector',
        extra: { max_tokens: 64 },
      }).ok,
    ).toBe(false);
    expect(
      assessProtectedForwardedExtras({
        connectorClassName: 'PerplexityConnector',
        extra: {
          max_tokens: 64,
          disable_search: true,
          web_search_options: { search_context_size: 'low' },
        },
      }).ok,
    ).toBe(false);
  });

  it('M-PPLXRF: counts response_format schema UTF-8 into the input bound', () => {
    const schema = {
      type: 'json_schema',
      json_schema: { name: 'x', schema: { type: 'object' }, description: 'Z'.repeat(500) },
    };
    const without = assessProtectedForwardedExtras({
      connectorClassName: 'PerplexityConnector',
      extra: { max_tokens: 1, disable_search: true },
    });
    const withSchema = assessProtectedForwardedExtras({
      connectorClassName: 'PerplexityConnector',
      extra: { max_tokens: 1, disable_search: true, response_format: schema },
    });
    expect(without.ok).toBe(true);
    expect(withSchema.ok).toBe(true);
    if (!without.ok || !withSchema.ok) return;
    expect(withSchema.countedInputBytes).toBeGreaterThan(without.countedInputBytes);
  });

  it('Azure tools extras are counted; sampling stays neutral', () => {
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const result = assessProtectedForwardedExtras({
      connectorClassName: 'AzureOpenAiConnector',
      extra: { max_tokens: 32, temperature: 0.2, tools },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.countedInputBytes).toBeGreaterThan(0);
  });
});
