/** Raw-only receiving CLI. External guardian/resource qualification is mandatory and separate.
 * Invocation: node -r ts-node/register test/diagnostic/df60-raw-cli.ts input sha256 output apiKeyId
 * Private instrument inputs must exclude the oracle. This CLI does not grant isolation,
 * settle a ledger, qualify a crash receiver, or create PG/Redis resources.
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { open, lstat, readFile } from 'node:fs/promises';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { RawCase } from './df60-adapter';

const fields = new Set([
  'id',
  'request',
  'stdout',
  'stderr',
  'exitCode',
  'fault',
  'input_sha256',
  'stdout_sha256',
]);
const faults = new Set([
  'none',
  'circuit',
  'timeout',
  'before-send',
  'wrong-read-id',
  'delete-row',
  'read-only-transaction',
  'second-attempt',
  'crashed-ledger',
]);
export function decodeRawCase(bytes: Buffer, digest: string): RawCase {
  if (
    !/^[a-f0-9]{64}$/.test(digest) ||
    bytes.length > 1024 * 1024 ||
    createHash('sha256').update(bytes).digest('hex') !== digest
  )
    throw new Error('DIAG raw input binding refused');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('DIAG raw input decoding refused');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('DIAG raw shape refused');
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !fields.has(key)) ||
    typeof raw.id !== 'string' ||
    !/^[a-z0-9_-]+$/.test(raw.id) ||
    typeof raw.stdout !== 'string' ||
    typeof raw.stderr !== 'string' ||
    !Number.isInteger(raw.exitCode) ||
    typeof raw.fault !== 'string' ||
    !faults.has(raw.fault) ||
    !raw.request ||
    typeof raw.request !== 'object' ||
    Array.isArray(raw.request) ||
    typeof (raw.request as Record<string, unknown>).prompt !== 'string'
  )
    throw new Error('DIAG raw shape refused');
  return raw as unknown as RawCase;
}

export async function main(args: string[]) {
  if (args.length !== 4) throw new Error('DIAG raw CLI arity refused');
  const [input, digest, output, apiKeyId] = args;
  const stat = await lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('DIAG input custody refused');
  const fixture = decodeRawCase(await readFile(input), digest);
  // Own resource IDs/namespace/process closure must be independently admitted by the parent.
  // A synthetic URL or MC_NO_EGRESS flag is not that receipt.
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.env.MC_NO_EGRESS !== '1' ||
    url.hostname !== 'mc-diag-pg' ||
    url.username !== 'test' ||
    url.password !== 'test' ||
    url.pathname !== '/diag_df60'
  )
    throw new Error('DIAG disposable DB binding refused before connection');
  // Hold exclusive output custody BEFORE App/DB or transport can enter.
  // Failed runs retain an incomplete private file, never a success record.
  const handle = await open(output, 'wx', 0o600);
  let writer: PrismaService | undefined;
  try {
    const { runComposedDiagnostic } = await import('./df60-composition');
    writer = new PrismaService();
    await writer.$connect();
    const key = await writer.apiKey.findUnique({ where: { id: apiKeyId } });
    if (!key || !key.active || key.name !== 'df60-disposable-offline')
      throw new Error('DIAG disposable key binding refused');
    const observation = await runComposedDiagnostic(fixture, writer, apiKeyId);
    const record = {
      ...observation,
      inputBytesSha256: digest,
      accountingAdmission: 'NOT_MEASURED',
      // Keep real independently read rows/costSource/costUsd; synthetic stdout cost is no settlement.
      settlementMicrousd: null,
      resourceQualification: 'EXTERNAL_RECEIPT_REQUIRED',
    };
    await handle.writeFile(JSON.stringify(record) + '\n');
    await handle.sync();
  } finally {
    try {
      await writer?.$disconnect();
    } finally {
      await handle.close();
    }
  }
}
if (require.main === module)
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('DIAG raw CLI refused; no admission or settlement asserted\n');
    process.exitCode = 1;
  });
