import { it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './monetary-v2.fixture';
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

// Synthetic transport only: no account, Journal, provider or real authority.
for (const mode of ['exact-limit', 'one-over', 'multibyte', 'json-escaping'] as const) {
  it(`bounds the complete UTF-8 envelope before child creation: ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-envelope-bound-'));
    const marker = join(root, 'child-started'),
      childScript = join(root, 'executor.cjs');
    writeFileSync(
      childScript,
      `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)},'started');
fs.readFileSync(3);let chunks=[];
process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{
 const raw=Buffer.concat(chunks);JSON.parse(raw.toString('utf8'));
 process.stdout.write(JSON.stringify({bytes:raw.length}));
});`,
      { mode: 0o600 },
    );
    try {
      const body = (wire: string) =>
        JSON.stringify({
          request: {},
          wire_utf8: wire,
          charging_policy_utf8: 'synthetic-policy',
          wire_bounds_utf8: 'synthetic-bounds',
          deadline_unix: 1005,
        });
      const overhead = Buffer.byteLength(body(''), 'utf8');
      const room = 8388608 - overhead;
      const wire =
        mode === 'exact-limit'
          ? 'x'.repeat(room)
          : mode === 'one-over'
            ? 'x'.repeat(room + 1)
            : mode === 'multibyte'
              ? 'é'.repeat(Math.floor(room / 2) + 1)
              : '\"'.repeat(Math.floor(room / 2) + 1);
      const serialized = body(wire);
      const input = {
        request: {},
        wire,
        charging_policy_utf8: 'synthetic-policy',
        wire_bounds_utf8: 'synthetic-bounds',
        deadline_unix: 1005,
        assertFresh: () => {},
      } as unknown as MonetaryAtomicInput;
      const call = incumbentJournalBridge({
        executable: process.execPath,
        args: [childScript],
        authorityContext: Buffer.from('synthetic transport fixture only'),
        temporaryDirectory: root,
        now: () => 1000,
      });
      if (mode === 'exact-limit') {
        expect(Buffer.byteLength(serialized, 'utf8')).toBe(8388608);
        await expect(call(input)).resolves.toEqual({ bytes: 8388608 });
        expect(existsSync(marker)).toBe(true);
      } else {
        expect(wire.length).toBeLessThanOrEqual(8388608);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(8388608);
        await expect(call(input)).rejects.toThrow('journal_bridge_unknown_preserved');
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
