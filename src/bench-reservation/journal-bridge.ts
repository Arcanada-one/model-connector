import { spawn } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { BenchRefused, requireBench } from './contract';
import { digest } from './signatures';
import type { MonetaryAtomicInput } from './monetary-v2';

const refused = () => new BenchRefused('journal_bridge_unknown_preserved');
const kinds = ['charging-policy', 'wire-bounds'] as const;
type ProofKind = typeof kinds[number];
/** All pins/signatures come from incumbent authenticated constructor custody.
 * Nothing is discovered, minted or accepted from reservation input. */
export function pinnedMonetaryProofVerifier(publicDer: Buffer, expectedDigest: string,
  signatures: Record<ProofKind, Buffer>) {
  requireBench(publicDer.length === 44 && publicDer.subarray(0, 12).toString('hex') ===
    '302a300506032b6570032100' && /^[a-f0-9]{64}$/.test(expectedDigest) &&
    digest(publicDer) === expectedDigest && Object.keys(signatures).length === 2 &&
    kinds.every(k => Buffer.isBuffer(signatures[k]) && signatures[k].length === 64),
  'proof_issuer_pin_refused');
  const key = createPublicKey({ key: Buffer.from(publicDer), type: 'spki', format: 'der' });
  const frozen = { 'charging-policy': Buffer.from(signatures['charging-policy']),
    'wire-bounds': Buffer.from(signatures['wire-bounds']) };
  return async (kind: ProofKind, raw: string): Promise<boolean> => {
    try {
      if (!kinds.includes(kind) || !raw || Buffer.byteLength(raw) > 65536) return false;
      return verify(null, Buffer.from(`BENCH-MONETARY-PROOF-v1\n${kind}\n${raw}`), key, frozen[kind]);
    } catch { return false; }
  };
}

export type IncumbentJournalProcess = Readonly<{
  executable: string;
  args: readonly string[];
  /** Separately authenticated fixed custody/admission binding, not request input.
   * The incumbent executor must validate it, current authority and existing store.
   * This adapter never initializes a Journal or treats this blob as a grant. */
  authorityContext: Buffer;
  temporaryDirectory: string;
  now: () => number;
}>;
/** Concrete one-shot process transport. The installed incumbent command and
 * authenticated authority context must be supplied explicitly; no defaults,
 * shell, retry, refund, key loading, Journal creation or runtime activation. */
export function incumbentJournalBridge(config: IncumbentJournalProcess) {
  requireBench(isAbsolute(config.executable) && config.args.every(x => typeof x === 'string') &&
    Buffer.isBuffer(config.authorityContext) && config.authorityContext.length > 0 &&
    config.authorityContext.length <= 262144 && typeof config.now === 'function',
  'journal_executor_not_bound');
  const temporaryDirectory = config.temporaryDirectory;
  const directory = lstatSync(temporaryDirectory);
  requireBench(isAbsolute(temporaryDirectory) && realpathSync(temporaryDirectory) === temporaryDirectory &&
    directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.() &&
    (directory.mode & 0o777) === 0o700, 'journal_private_temp_refused');
  const args = [...config.args], context = Buffer.from(config.authorityContext),
    executable = config.executable, now = config.now;
  return async (input: MonetaryAtomicInput): Promise<unknown> => {
    try {
      input.assertFresh();
      const milliseconds = (input.deadline_unix - now()) * 1000;
      requireBench(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 5000,
        'journal_deadline_refused');
      const body = JSON.stringify({ request: input.request, wire_utf8: input.wire,
        charging_policy_utf8: input.charging_policy_utf8, wire_bounds_utf8: input.wire_bounds_utf8,
        deadline_unix: input.deadline_unix });
      // The incumbent stdin limit covers the complete escaped UTF-8 envelope,
      // not just the model wire. Refuse before any child or private pipe exists.
      requireBench(Buffer.byteLength(body, 'utf8') <= 8388608,
        'journal_envelope_limit_refused');
      const value = await new Promise<unknown>((resolve, reject) => {
        const child = spawn(executable, args, { shell: false,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: temporaryDirectory }, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
        let chunks: Buffer[] = [], bytes = 0, settled = false;
        const finish = (error?: Error, result?: unknown) => {
          if (settled) return;
          settled = true; clearTimeout(timer); chunks = [];
          if (error) { child.kill('SIGTERM'); reject(refused()); } else resolve(result);
        };
        const timer = setTimeout(() => finish(refused()), milliseconds);
        child.on('error', () => finish(refused()));
        child.stdin!.on('error', () => finish(refused()));
        const privatePipe = child.stdio[3];
        requireBench(privatePipe !== null && privatePipe !== undefined && 'write' in privatePipe, 'journal_private_pipe_missing');
        privatePipe.on('error', () => finish(refused()));
        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 262144) finish(refused()); else if (!settled) chunks.push(chunk);
        });
        child.on('close', code => {
          if (settled) return;
          if (code !== 0) return finish(refused());
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(refused()); }
        });
        privatePipe.end(context);
        child.stdin!.end(body);
      });
      input.assertFresh();
      return value;
    } catch { throw refused(); }
  };
}
