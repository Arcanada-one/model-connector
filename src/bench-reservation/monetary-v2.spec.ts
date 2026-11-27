import { describe, it, expect } from 'vitest';
import { createPublicKey } from 'node:crypto';
import { BenchMonetaryV2Receiver, monetaryCanonical } from './monetary-v2';
import { BenchTrustedSocketAdapter } from './adapter';
import { BenchRefused } from './contract';
import { canonical, verifyEnvelope } from './signatures';
import { fixture } from './monetary-v2.fixture';

// Synthetic offline keys only, generated in memory. No native key/session,
// protected credential, provider, database, socket listener or grant is loaded.
describe('strict native8daa monetary-v2 receiver source', () => {
  it('matches incumbent canonical ASCII escaping without losing complete Unicode input', () => {
    expect(monetaryCanonical({ b: '😀', a: 'é' })).toBe('{"a":"\\u00e9","b":"\\ud83d\\ude00"}');
  });
  it('signs exact v2 request/witness only after the one incumbent callback', async () => {
    const f = fixture(),
      input = f.envelope();
    const reply = await new BenchMonetaryV2Receiver(f.deps).reserveEnvelope(input);
    const parsed = JSON.parse(
      verifyEnvelope(
        reply,
        createPublicKey(f.deps.custodianPrivateKey),
        'BENCH-CUSTODY-RESERVATION-v2\n',
      ),
    );
    expect(parsed.request).toEqual(input.request);
    expect(parsed.monetary.next_money).toBe(31);
    expect(f.calls()).toBe(1);
  });
  for (const condition of [
    'executor',
    'verifier',
    'proof-auth',
    'caller',
    'signature-domain',
    'unknown-field',
    'old-version',
    'wire-digest',
    'scope',
    'units',
    'head',
    'output',
    'proof-expiry',
    'dollar-cap',
    'missing-output-proof',
  ]) {
    it(`refuses ${condition} before any atomic callback`, async () => {
      const f = fixture();
      let input = f.envelope();
      switch (condition) {
        case 'executor':
          f.deps.reserveAtomic = undefined;
          break;
        case 'verifier':
          f.deps.verifyProof = undefined;
          break;
        case 'proof-auth':
          f.deps.verifyProof = async () => false;
          break;
        case 'caller':
          input.caller_access_token = 'never-a-token';
          break;
        case 'signature-domain':
          input.signed_grant.payload += ' ';
          break;
        case 'unknown-field':
          (input as typeof input & { extra?: boolean }).extra = true;
          break;
        case 'old-version':
          input.schema = 'NativeBenchCustodyEnvelope/v1';
          break;
        case 'wire-digest':
          input.wire_utf8 += ' ';
          break;
        case 'scope':
          input.request.monetary_request.account = 'foreign';
          break;
        case 'units':
          input.request.reserved_units[1] = 'measured_tokens';
          break;
        case 'head':
          input.request.monetary_checkpoint_head_sha256 = '0'.repeat(64);
          break;
        case 'output':
          f.bounds.output_upper = 1;
          input = f.envelope();
          break;
        case 'proof-expiry':
          f.policy.expires = 999;
          input = f.envelope();
          break;
        case 'dollar-cap':
          f.policy.money_cap = 101;
          input = f.envelope();
          break;
        case 'missing-output-proof':
          f.bounds.output_enforcement = 'unqualified';
          input = f.envelope();
          break;
      }
      await expect(new BenchMonetaryV2Receiver(f.deps).reserveEnvelope(input)).rejects.toThrow();
      expect(f.calls()).toBe(0);
    });
  }
  it('refuses unsupported max_output_tokens despite authentic synthetic proof', async () => {
    const f = fixture();
    f.replaceWire(
      canonical({
        model: 'gpt-6-luna',
        input: 'complete',
        max_output_tokens: 128,
      }),
    );
    await expect(
      new BenchMonetaryV2Receiver(f.deps).reserveEnvelope(f.envelope()),
    ).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });
  for (const bad of [
    'head',
    'refund',
    'cost',
    'aggregate',
    'projection',
    'extra',
    'late',
    'error',
  ]) {
    it(`refuses ${bad} after callback without fallback/retry`, async () => {
      const f = fixture(),
        original = f.deps.reserveAtomic!;
      f.deps.reserveAtomic = async (input) => {
        const r = (await original(input)) as {
          monetary: {
            previous_head_sha256: string;
            next_money: number;
            cost: number;
            projection_binding_sha256: string;
            unknown?: boolean;
          };
          aggregate: number[];
        };
        if (bad === 'head') r.monetary.previous_head_sha256 = '0'.repeat(64);
        if (bad === 'refund') r.monetary.next_money = 0;
        if (bad === 'cost') {
          r.monetary.cost = 0;
          r.monetary.next_money = 30;
        }
        if (bad === 'aggregate') r.aggregate[1]--;
        if (bad === 'projection') r.monetary.projection_binding_sha256 = '0'.repeat(64);
        if (bad === 'extra') r.monetary.unknown = true;
        if (bad === 'late') f.advance();
        if (bad === 'error') throw new Error('synthetic untrusted body sentinel');
        return r;
      };
      const receiver = new BenchMonetaryV2Receiver(f.deps);
      await expect(receiver.reserveEnvelope(f.envelope())).rejects.toThrow();
      expect(f.calls()).toBe(1);
    });
  }
  for (const callback of ['verifyProof', 'reserveAtomic'] as const) {
    it(`sanitizes typed ${callback} exceptions without body disclosure`, async () => {
      const f = fixture();
      f.deps[callback] = async () => {
        throw new BenchRefused('UNTRUSTED_BODY_SENTINEL');
      };
      await expect(
        new BenchMonetaryV2Receiver(f.deps).reserveEnvelope(f.envelope()),
      ).rejects.toThrow('monetary_v2_refused_unknown_preserved');
    });
  }
  it('missing v2 receiver never falls back to original token-only reserve', async () => {
    const f = fixture();
    let legacy = 0;
    const adapter = new BenchTrustedSocketAdapter(
      {
        reserve: async () => {
          legacy++;
        },
      } as unknown as ConstructorParameters<typeof BenchTrustedSocketAdapter>[0],
      f.grant.custodian_socket,
    );
    await expect(adapter.reserveEnvelope(f.envelope())).rejects.toThrow(
      'monetary_executor_not_bound',
    );
    expect(legacy).toBe(0);
  });
  it('adapter dispatches to v2 receiver without invoking legacy token store', async () => {
    const f = fixture();
    let legacy = 0;
    const adapter = new BenchTrustedSocketAdapter(
      {
        reserve: async () => {
          legacy++;
        },
      } as unknown as ConstructorParameters<typeof BenchTrustedSocketAdapter>[0],
      f.grant.custodian_socket,
      new BenchMonetaryV2Receiver(f.deps),
    );
    await adapter.reserveEnvelope(f.envelope());
    expect(f.calls()).toBe(1);
    expect(legacy).toBe(0);
  });
});
