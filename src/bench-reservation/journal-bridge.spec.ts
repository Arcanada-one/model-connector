import { it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './monetary-v2.spec';
import { incumbentJournalBridge, pinnedMonetaryProofVerifier } from './journal-bridge';
import { digest } from './signatures';
import type { MonetaryAtomicInput } from './monetary-v2';

const python = '/usr/bin/python3';
const domain = (kind: string, raw: string) =>
  Buffer.from(`BENCH-MONETARY-PROOF-v1\n${kind}\n${raw}`);

it('refuses missing executor context and wrong externally pinned public key', async () => {
  expect(() =>
    incumbentJournalBridge({
      executable: python,
      args: [],
      authorityContext: Buffer.alloc(0),
      temporaryDirectory: tmpdir(),
      now: () => 1000,
    }),
  ).toThrow();
  const keys = generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ type: 'spki', format: 'der' });
  expect(() =>
    pinnedMonetaryProofVerifier(der, '0'.repeat(64), {
      'charging-policy': Buffer.alloc(64),
      'wire-bounds': Buffer.alloc(64),
    }),
  ).toThrow();
});
it('verifies real detached proof signatures under pinned domain and immutable bytes', async () => {
  const keys = generateKeyPairSync('ed25519'),
    raw = '{"proof":"synthetic"}';
  const der = keys.publicKey.export({ type: 'spki', format: 'der' });
  const verifier = pinnedMonetaryProofVerifier(der, digest(der), {
    'charging-policy': sign(null, domain('charging-policy', raw), keys.privateKey),
    'wire-bounds': sign(null, domain('wire-bounds', raw), keys.privateKey),
  });
  expect(await verifier('charging-policy', raw)).toBe(true);
  expect(await verifier('charging-policy', raw + ' ')).toBe(false);
});
it('passes exact immutable proof bytes and the minimum proof deadline to its executor', async () => {
  const f = fixture();
  f.policy.expires = 1003;
  const envelope = f.envelope(),
    original = f.deps.reserveAtomic!;
  let captured: MonetaryAtomicInput | undefined;
  f.deps.reserveAtomic = async (input) => {
    captured = input;
    return original(input);
  };
  await expect(
    new (await import('./monetary-v2')).BenchMonetaryV2Receiver(f.deps).reserveEnvelope(envelope),
  ).rejects.toThrow();
  expect(captured?.charging_policy_utf8).toBe(envelope.charging_policy_utf8);
  expect(captured?.wire_bounds_utf8).toBe(envelope.wire_bounds_utf8);
  expect(captured?.deadline_unix).toBe(1003);
});

it('keeps request/context out of real process argv and sanitizes invalid child output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-private-transport-'));
  const childScript = join(root, 'executor.cjs');
  writeFileSync(
    childScript,
    `const fs=require('node:fs');
const context=fs.readFileSync(3,'utf8');let body='';
process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{
 const argv=fs.readFileSync('/proc/self/cmdline','utf8');
 if(argv.includes(context)||argv.includes(body))process.exit(2);
 process.stderr.write('UNTRUSTED_CHILD_BODY');process.stdout.write('INVALID_CHILD_BODY');
});`,
    { mode: 0o600 },
  );
  try {
    const f = fixture();
    f.deps.reserveAtomic = incumbentJournalBridge({
      executable: process.execPath,
      args: [childScript],
      authorityContext: Buffer.from('PRIVATE_CONTEXT_SENTINEL'),
      temporaryDirectory: root,
      now: f.deps.now,
    });
    const Receiver = (await import('./monetary-v2')).BenchMonetaryV2Receiver;
    await expect(new Receiver(f.deps).reserveEnvelope(f.envelope())).rejects.toThrow(
      'monetary_v2_refused_unknown_preserved',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
