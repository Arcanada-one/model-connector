/**
 * Opt-in Billing3a Journal bridge controls. Not part of maintained Vitest membership
 * (`.live.ts` is excluded from graph-full-suite inventory). Run with
 * BILLING_CUSTODIAN_SOURCE set when measuring the pinned custodian snapshot.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from './monetary-v2.spec';
import { incumbentJournalBridge, pinnedMonetaryProofVerifier } from './journal-bridge';
import { canonical, digest, verifyEnvelope } from './signatures';

const python = '/usr/bin/python3';
const script = resolve('test/fixtures/bench-journal-custodian.py');
const billingSource = process.env.BILLING_CUSTODIAN_SOURCE;
const billingPins = resolve('test/fixtures/billing-3a-module-pins.json');
const domain = (kind: string, raw: string) =>
  Buffer.from(`BENCH-MONETARY-PROOF-v1\n${kind}\n${raw}`);

describe.skipIf(!billingSource)(
  'actual pinned Billing3a Journal bridge, offline synthetic authority',
  () => {
    for (const mode of ['success', 'altered-context', 'late', 'replay'] as const) {
      it(`preserves real Journal liabilities and refusal for ${mode}`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'mc-journal-bridge-'));
        const store = join(root, 'store');
        mkdirSync(store, { mode: 0o700 });
        const base = {
          fixture_only: true,
          module_dir: billingSource,
          module_pins: JSON.parse(readFileSync(billingPins, 'utf8')),
          store,
          synthetic_clock: 1000,
        };
        const { spawn } = await import('node:child_process');
        const privateCall = async (context: unknown): Promise<Record<string, unknown>> =>
          new Promise((accept, reject) => {
            const child = spawn(python, [script], {
              env: { PATH: '/usr/bin:/bin', LANG: 'C' },
              stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
            });
            const timer = setTimeout(() => {
              child.kill('SIGTERM');
              reject(new Error('fixture_timeout'));
            }, 5000);
            let output = '';
            child.stdout!.on('data', (b) => {
              output += b.toString();
            });
            child.on('error', () => {
              clearTimeout(timer);
              reject(new Error('fixture_spawn'));
            });
            child.on('close', (code) => {
              clearTimeout(timer);
              if (code !== 0) reject(new Error('fixture_refused'));
              else {
                try {
                  accept(JSON.parse(output));
                } catch {
                  reject(new Error('fixture_output'));
                }
              }
            });
            const fd = child.stdio[3];
            if (!fd || !('end' in fd)) return reject(new Error('fixture_fd'));
            fd.end(JSON.stringify(context));
            child.stdin!.end();
          });
        try {
          const init = await privateCall({ ...base, mode: 'bootstrap_fixture' });
          const f = fixture();
          f.scope.campaign = '1'.repeat(64);
          f.grant.campaign = f.scope.campaign;
          f.policy.campaign = f.scope.campaign;
          f.bounds.campaign = f.scope.campaign;
          f.policy.baseline_head = String(init.head);
          f.grant.monetary.expected_head_sha256 = String(init.head);
          f.replaceWire(
            canonical({
              model: 'gpt-6-luna',
              input: [{ type: 'message', role: 'user', content: 'synthetic complete é wire' }],
            }),
          );
          const envelope = f.envelope(),
            keys = generateKeyPairSync('ed25519');
          const der = keys.publicKey.export({ type: 'spki', format: 'der' });
          const signatures = {
            'charging-policy': sign(
              null,
              domain('charging-policy', envelope.charging_policy_utf8),
              keys.privateKey,
            ),
            'wire-bounds': sign(
              null,
              domain('wire-bounds', envelope.wire_bounds_utf8),
              keys.privateKey,
            ),
          };
          f.deps.verifyProof = pinnedMonetaryProofVerifier(der, digest(der), signatures);
          const expected = {
            request: envelope.request,
            wire_utf8: envelope.wire_utf8,
            charging_policy_utf8: envelope.charging_policy_utf8,
            wire_bounds_utf8: envelope.wire_bounds_utf8,
            deadline_unix: 1005,
          };
          const context = {
            ...base,
            mode: 'reserve_fixture',
            expected: { ...expected, deadline_unix: mode === 'altered-context' ? 1004 : 1005 },
            public_der_hex: der.toString('hex'),
            issuer_digest: digest(der),
            signatures: Object.fromEntries(
              Object.entries(signatures).map(([k, v]) => [k, v.toString('hex')]),
            ),
            late_after_unknown: mode === 'late',
          };
          f.deps.reserveAtomic = incumbentJournalBridge({
            executable: python,
            args: [script],
            authorityContext: Buffer.from(JSON.stringify(context)),
            temporaryDirectory: root,
            now: f.deps.now,
          });
          const Receiver = (await import('./monetary-v2')).BenchMonetaryV2Receiver;
          if (mode === 'late' || mode === 'altered-context') {
            await expect(new Receiver(f.deps).reserveEnvelope(envelope)).rejects.toThrow(
              'monetary_v2_refused_unknown_preserved',
            );
          } else {
            const signed = await new Receiver(f.deps).reserveEnvelope(envelope);
            const { createPublicKey } = await import('node:crypto');
            const receipt = JSON.parse(
              verifyEnvelope(
                signed,
                createPublicKey(f.deps.custodianPrivateKey),
                'BENCH-CUSTODY-RESERVATION-v2\n',
              ),
            );
            expect(receipt.monetary.next_money).toBe(31);
            if (mode === 'replay')
              await expect(new Receiver(f.deps).reserveEnvelope(envelope)).rejects.toThrow();
          }
          const observation = await privateCall({ ...base, mode: 'observe_fixture' });
          expect(observation.events).toBe(mode === 'altered-context' ? 0 : 2);
          expect(observation.unknown).toBe(mode === 'altered-context' ? 0 : 1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  },
);
