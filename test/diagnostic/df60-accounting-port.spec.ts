import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyAccountingRow, validateAccountingIdentity } from './df60-accounting-port';
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
