// AUP-CACHE-006 — the vendored contract loads by digest; every malformed copy is refused.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROMPT_LAYOUT_CONTRACT_PATH,
  PROMPT_LAYOUT_CONTRACT_SHA256,
  PromptLayoutContractError,
  compileContractPattern,
  loadPromptLayoutContract,
  loadVendoredPromptLayoutContract,
  resolveContractModel,
} from './prompt-layout-contract';
import { PROMPT_LAYOUT_V1_TEXT } from './contract/prompt-layout.v1.embedded';

const bytes = readFileSync(PROMPT_LAYOUT_CONTRACT_PATH);
const good = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;

/** Load a mutant through the shape checks by pinning the digest to the mutant's own bytes. */
function loadMutant(mutate: (doc: Record<string, unknown>) => void) {
  const doc = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  mutate(doc);
  const text = JSON.stringify(doc);
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  return () => loadPromptLayoutContract(text, digest);
}

describe('prompt-layout contract loader (AUP-CACHE-006)', () => {
  it('loads the vendored copy and pins its digest', () => {
    const contract = loadVendoredPromptLayoutContract();
    expect(contract.digest).toBe(`sha256:${PROMPT_LAYOUT_CONTRACT_SHA256}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PROMPT_LAYOUT_CONTRACT_SHA256);
    // The embedded (runtime) text is byte-identical to the reviewable .json copy.
    expect(PROMPT_LAYOUT_V1_TEXT).toBe(bytes.toString('utf8'));
    expect(loadPromptLayoutContract(Buffer.from(PROMPT_LAYOUT_V1_TEXT, 'utf8')).digest).toBe(
      contract.digest,
    );
    expect(contract.schema).toBe('PromptLayoutContract/v1');
    expect(contract.id).toBe('prompt-layout.v1');
    expect(Object.keys(contract.models)).toHaveLength(6);
    expect(contract.models['claude-fable-5-1'].min_prefix_tokens).toBe(512);
    expect(contract.models['claude-haiku-4-5'].min_prefix_tokens).toBe(4096);
    expect(contract.maxExplicitBreakpoints).toBe(4);
    expect(contract.ttlValues).toEqual(['5m', '1h']);
    expect(Object.keys(contract.violationCodes)).toHaveLength(30);
    expect(contract.violationCodes.SECRET_IN_PREFIX.severity).toBe('refusal');
    expect(contract.violationCodes.MODEL_UNKNOWN.severity).toBe('undetermined');
    expect(contract.scanRules.map((r) => r.code)).toEqual([
      'DYN_TIMESTAMP',
      'DYN_UUID',
      'DYN_COUNTER',
      'DYN_ENV',
      'SESSION_ID_IN_PREFIX',
      'FEATURE_FLAG_IN_PREFIX',
      'USER_IDENTITY_IN_PREFIX',
      'TENANT_IN_PREFIX',
      'SECRET_IN_PREFIX',
    ]);
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it('refuses a copy whose bytes differ from the pinned digest', () => {
    const edited = Buffer.from(
      bytes.toString('utf8').replace('"min_prefix_tokens": 512', '"min_prefix_tokens": 1'),
    );
    expect(() => loadPromptLayoutContract(edited)).toThrow(PromptLayoutContractError);
    expect(() => loadPromptLayoutContract(edited)).toThrow(/does not match the pinned/);
  });

  it('refuses a copy that is not JSON, not an object, or of another schema/id', () => {
    const text = '{not json';
    const digest = createHash('sha256').update(text).digest('hex');
    expect(() => loadPromptLayoutContract(text, digest)).toThrow(/not valid JSON/);
    const arr = '[]';
    expect(() =>
      loadPromptLayoutContract(arr, createHash('sha256').update(arr).digest('hex')),
    ).toThrow(/not a JSON object/);
    expect(loadMutant((d) => (d.schema = 'PromptLayoutContract/v2'))).toThrow(/schema is/);
    expect(loadMutant((d) => (d.id = 'prompt-layout.v2'))).toThrow(/id is/);
  });

  it('refuses malformed model, breakpoint and TTL facts', () => {
    expect(loadMutant((d) => (d.models = {}))).toThrow(/models is missing or empty/);
    expect(
      loadMutant((d) => {
        (d.models as Record<string, Record<string, unknown>>)['claude-opus-5'].min_prefix_tokens =
          '512';
      }),
    ).toThrow(/min_prefix_tokens/);
    expect(
      loadMutant((d) => {
        (d.models as Record<string, Record<string, unknown>>)['claude-opus-5'].read_multiplier = 0;
      }),
    ).toThrow(/read_multiplier/);
    expect(
      loadMutant((d) => {
        (d.official_facts as Record<string, unknown>).max_explicit_breakpoints = 0;
      }),
    ).toThrow(/max_explicit_breakpoints/);
    expect(
      loadMutant((d) => {
        (d.official_facts as Record<string, unknown>).ttl_values = [];
      }),
    ).toThrow(/ttl_values/);
  });

  it('refuses malformed violation codes and scan patterns', () => {
    expect(
      loadMutant((d) => {
        (d.violation_codes as Record<string, Record<string, unknown>>).SECRET_IN_PREFIX.severity =
          'fatal';
      }),
    ).toThrow(/severity "fatal"/);
    expect(
      loadMutant((d) => {
        (d.violation_codes as Record<string, Record<string, unknown>>).TTL_ORDER.scope = 'global';
      }),
    ).toThrow(/scope "global"/);
    expect(
      loadMutant((d) => {
        (d.scan_patterns as Record<string, unknown>).NOT_A_CODE = ['x'];
      }),
    ).toThrow(/no entry in violation_codes/);
    expect(
      loadMutant((d) => {
        (d.scan_patterns as Record<string, unknown>).SECRET_IN_PREFIX = [];
      }),
    ).toThrow(/non-empty array/);
    expect(
      loadMutant((d) => {
        (d.scan_patterns as Record<string, unknown>).SECRET_IN_PREFIX = ['(unclosed'];
      }),
    ).toThrow(/does not compile/);
    expect(
      loadMutant((d) => {
        (d.scan_patterns as Record<string, unknown>).SECRET_IN_PREFIX = ['(?s)a.b'];
      }),
    ).toThrow(/inline flag/);
    expect(
      loadMutant((d) => {
        delete (d.scan_patterns as Record<string, unknown>).SECRET_IN_PREFIX;
      }),
    ).toThrow(/lacks SECRET_IN_PREFIX/);
    expect(
      loadMutant((d) => {
        delete (d.scan_patterns as Record<string, unknown>).TENANT_IN_PREFIX;
      }),
    ).toThrow(/lacks TENANT_IN_PREFIX/);
    expect(
      loadMutant((d) => {
        delete (d.verdicts as Record<string, unknown>).UNDETERMINED;
      }),
    ).toThrow(/lacks UNDETERMINED/);
  });

  it('ports the Python (?i) flag and keeps patterns stateless', () => {
    const rx = compileContractPattern('(?i)\\btenant\\s*[:=]\\s*\\S+');
    expect(rx.flags).toBe('i');
    expect(rx.test('TENANT: acme')).toBe(true);
    expect(rx.test('TENANT: acme')).toBe(true); // no lastIndex carry-over
    expect(compileContractPattern('mun_sk_[A-Za-z0-9_]{8,}').flags).toBe('');
  });

  it('resolves models by longest prefix and never guesses an unknown one', () => {
    const contract = loadVendoredPromptLayoutContract();
    expect(resolveContractModel(contract, 'claude-haiku-4-5-20251001')?.key).toBe(
      'claude-haiku-4-5',
    );
    expect(resolveContractModel(contract, 'claude-fable-5-1')?.model.min_prefix_tokens).toBe(512);
    expect(resolveContractModel(contract, 'claude-sonnet-4-5')).toBeNull();
    expect(resolveContractModel(contract, undefined)).toBeNull();
  });
});
