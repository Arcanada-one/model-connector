/** Inner Node entry port for the existing owned App OCI guardian.
 * This supplies a restricted instrument argv, never creates a resource or grants
 * namespace authority. INFRA must bind physical owned PG/Redis/internal network;
 * SCI owns the absolute deadline, drain and ledger. Oracle is never an input.
 */
export function nodePgRawEntry(digest: string, apiKeyId: string) {
  if (
    !/^[a-f0-9]{64}$/.test(digest) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(apiKeyId)
  )
    throw new Error('DIAG NodePG entry binding refused');
  return Object.freeze({
    argv: Object.freeze([
      'node',
      '-r',
      'ts-node/register',
      'test/diagnostic/df60-raw-cli.ts',
      '/diag-input/case.json',
      digest,
      '/diag-output/observation.json',
      apiKeyId,
    ]),
    databaseAlias: 'mc-diag-pg',
    databaseName: 'diag_df60',
    redisAlias: 'mc-diag-redis',
    guardianSource: 'scripts/app-e2e-disposable.sh',
    intentReceiverSource: 'scripts/app-e2e-reconcile.py',
    sourceSnapshotReceiver: 'scripts/app-e2e-snapshot.py',
    independentAccountingReceiver:
      'test/diagnostic/df60-accounting-port.ts:readIndependentAccounting',
    inputMount: '/diag-input',
    outputMount: '/diag-output',
    oracleMount: null,
    physicalResourceAdmission: 'REQUIRES_EXISTING_INFRA_GUARDIAN_RECEIVING',
    settlementAuthority: 'SCI_PARENT_ONLY_AUTHENTIC_ACCOUNTING_REQUIRED',
  });
}
