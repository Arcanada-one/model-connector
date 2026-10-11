import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyAccountingRow, validateAccountingIdentity } from './df60-accounting-port';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
describe('independent SQL receiver source boundaries, no SQL/runtime execution', () => {
  it('cannot settle a correlated synthetic provider-looking zero', () => {
    const result = classifyAccountingRow(
      { id: 'request', apiKeyId: 'key', costSource: 'provider', costUsd: '0' },
      'key',
      'request',
    );
    expect(result.correlated).toBe(true);
    expect(result.accountingAdmission).toBe('NOT_MEASURED');
    expect(result.settlementMicrousd).toBeNull();
    expect(result.requiredParentAction).toBe('RETAIN_RESERVE_AND_REFUSE_SETTLEMENT');
  });
  it('cannot correlate another client row or a missing row', () => {
    expect(
      classifyAccountingRow(
        { id: 'request', apiKeyId: 'foreign', costSource: 'provider', costUsd: '0' },
        'key',
        'request',
      ).correlated,
    ).toBe(false);
    expect(classifyAccountingRow(null, 'key', 'request').correlated).toBe(false);
  });
  it('refuses malformed SQL identity before creating a Prisma connection', () => {
    expect(() => validateAccountingIdentity('foreign', 'not-a-uuid')).toThrow('identity refused');
  });
});

describe('actual child deadline controls with synthetic SQL/output, no native resources', () => {
  const source = readFileSync('test/diagnostic/df60-accounting-port.ts', 'utf8');
  function child(mode: string, deadlineOffset: number, mutant = false) {
    const compiled = transpileModule(
      mutant ? source.replace('process.exit(124);', 'return;') : source,
      { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } },
    ).outputText;
    const fixture = `
      const mode = ${JSON.stringify(mode)};
      const hold = () => new Promise(() => { setInterval(() => {}, 1000); });
      const marker = x => process.stderr.write(x + '\\n');
      class Reader {
        constructor() { marker('CONSTRUCT'); }
        async $connect() { marker('CONNECT'); if(mode === 'connect') await hold(); }
        async $transaction(fn) { marker('QUERY'); return fn({
          $executeRaw: async () => {}, request: { findFirst: async () => null }
        }); }
        async $disconnect() { marker('DISCONNECT'); if(mode === 'disconnect') await hold(); }
      }
      const ownRequire = name => {
        if(name.includes('prisma.service')) return { PrismaService: Reader };
        if(name === 'node:fs/promises') return { open: async (path, flags, modeBits) => {
          if(path !== '/diag-output/accounting.json' || flags !== 'wx' || modeBits !== 384)
            throw Error('output binding');
          marker('OUTPUT_ACQUIRED');
          if(mode === 'collision') throw Error('occupied output');
          return { writeFile: async text => process.stdout.write(text),
            sync: async () => marker('SYNC'), close: async () => marker('CLOSE') };
        }};
        return require(name);
      };
      const mod = { exports: {} };
      new Function('require','module','exports',${JSON.stringify(compiled)})(ownRequire,mod,mod.exports);
      mod.exports.accountingChildMain([
        ${JSON.stringify(keyId)},${JSON.stringify(requestId)},
        String(Date.now() + ${deadlineOffset})
      ]).catch(() => { marker('REFUSED'); process.exitCode = 1; });
    `;
    return spawnSync(process.execPath, ['-e', fixture], {
      encoding: 'utf8',
      timeout: 1800,
      maxBuffer: 65536,
      env: {
        PATH: process.env.PATH,
        MC_NO_EGRESS: '1',
        DATABASE_URL: 'postgresql://test:test@mc-diag-pg:5432/diag_df60',
      },
    });
  }
  it.each(['connect', 'disconnect'])('hard cutoff covers stalled %s', (phase) => {
    const result = child(phase, 250);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(phase.toUpperCase());
    expect(result.stderr).not.toContain('SYNC');
  });
  it('publishes raw NM only after disconnect and does not authorize settlement', () => {
    const result = child('positive', 1000);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('DISCONNECT\nSYNC\nCLOSE');
    expect(JSON.parse(result.stdout).accountingAdmission).toBe('NOT_MEASURED');
    expect(JSON.parse(result.stdout).settlementMicrousd).toBeNull();
  });
  it.each([-1, 40001])('refuses invalid inherited deadline %s before entry', (offset) => {
    const result = child('positive', offset);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('CONSTRUCT');
    expect(result.stderr).not.toContain('OUTPUT_ACQUIRED');
  });
  it('occupied output refuses before Prisma construction', () => {
    const result = child('collision', 1000);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('CONSTRUCT');
  });
  it('cutoff-removal control is detected by independent subprocess timeout', () => {
    const result = child('disconnect', 250, true);
    expect(result.status).not.toBe(124);
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(result.stdout).toBe('');
  });
});

const keyId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
describe('SQL connection target before Prisma entry, not namespace authority', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts only the fixed disposable connection spelling', () => {
    vi.stubEnv('MC_NO_EGRESS', '1');
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@mc-diag-pg:5432/diag_df60');
    expect(() => validateAccountingIdentity(keyId, requestId)).not.toThrow();
  });
  it.each([
    'http://test:test@mc-diag-pg:5432/diag_df60',
    'postgresql://test:test@mc-diag-pg:1234/diag_df60',
    'postgresql://test:test@mc-diag-pg:5432/diag_df60?host=foreign.invalid',
    'postgresql://test:test@mc-diag-pg:5432/diag_df60#foreign',
    'postgresql://test:test@mc-diag-pg/diag_df60',
    'postgresql://test:test@foreign.invalid:5432/diag_df60',
  ])('refuses altered connection target %s before constructing Prisma', (url) => {
    vi.stubEnv('MC_NO_EGRESS', '1');
    vi.stubEnv('DATABASE_URL', url);
    expect(() => validateAccountingIdentity(keyId, requestId)).toThrow('binding refused');
  });
});
