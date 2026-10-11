/** Independent real-SQL receiving port. SQL evidence alone never authorizes settlement.
 * Raw fixture/provider-looking costs are synthetic and cannot settle shared24 exposure.
 * Parent SCI owns reserve/abort/settle; INFRA owns physical namespace/store admission.
 */
import { PrismaService } from '../../src/prisma/prisma.service';

export function validateAccountingIdentity(apiKeyId: string, requestId: string) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!uuid.test(apiKeyId) || !uuid.test(requestId)) throw new Error('DIAG SQL identity refused');
  // Exact spelling excludes alternative protocols/ports and query target overrides.
  // This rejects an unsafe connection string; it does not prove OCI namespace custody.
  if (
    process.env.DATABASE_URL !== 'postgresql://test:test@mc-diag-pg:5432/diag_df60' ||
    process.env.MC_NO_EGRESS !== '1'
  )
    throw new Error('DIAG disposable SQL binding refused');
}
export function classifyAccountingRow(
  row: { id: string; apiKeyId: string; costSource: string | null; costUsd: unknown } | null,
  apiKeyId: string,
  requestId: string,
) {
  return {
    schema: 'MCIndependentSQLAccountingReceiving/v1',
    correlated: Boolean(row && row.id === requestId && row.apiKeyId === apiKeyId),
    observedRequestId: row?.id ?? null,
    observedCostSource: row?.costSource ?? null,
    observedCostUsd: row?.costUsd == null ? null : String(row.costUsd),
    accountingAdmission: 'NOT_MEASURED',
    settlementMicrousd: null,
    requiredParentAction: 'RETAIN_RESERVE_AND_REFUSE_SETTLEMENT',
    reason: 'RAW_FIXTURE_IS_NOT_AUTHENTIC_PROVIDER_ACCOUNTING',
  } as const;
}
// The existing SCI parent must bound and physically drain the whole child process,
// including connect/disconnect. The transaction timeout below bounds only its phase;
// neither a successful read nor a caller flag qualifies that external guardian.
export async function readIndependentAccounting(apiKeyId: string, requestId: string) {
  validateAccountingIdentity(apiKeyId, requestId);
  const reader = new PrismaService();
  try {
    await reader.$connect();
    const row = await reader.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
        return transaction.request.findFirst({
          where: { id: requestId, apiKeyId },
          select: { id: true, apiKeyId: true, costSource: true, costUsd: true },
        });
      },
      { timeout: 3000, maxWait: 1000 },
    );
    return classifyAccountingRow(row, apiKeyId, requestId);
  } finally {
    await reader.$disconnect();
  }
}
