/** df60 candidate instrument: real MC parser/service/SQL, raw transport seam only. */
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { ClaudeCodeConnector } from '../../src/connectors/claude-code/claude-code.connector';
import { ProcessTimeoutError, SpawnResult } from '../../src/connectors/base-cli.connector';
import { ConnectorsService } from '../../src/connectors/connectors.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { Prisma } from '@prisma/client';

export interface RawCase {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  fault:
    | 'none'
    | 'circuit'
    | 'timeout'
    | 'before-send'
    | 'wrong-read-id'
    | 'delete-row'
    | 'read-only-transaction'
    | 'second-attempt'
    | 'crashed-ledger';
}
class RawTransport extends ClaudeCodeConnector {
  received = 0;
  possibleDispatches = 0;
  constructor(private readonly stimulus: RawCase) {
    super();
  }
  openCircuit(model: string) {
    this.cbManager.getCircuitBreaker(model).recordFailure('auth_error');
  }
  protected override async spawnProcess(): Promise<SpawnResult> {
    this.received++;
    if (this.stimulus.fault === 'before-send')
      throw new Error('Synthetic transport unavailable before send');
    if (this.received > 1) throw new Error('DIAG unauthorized second transport attempt refused');
    this.possibleDispatches++;
    if (this.stimulus.fault === 'timeout') throw new ProcessTimeoutError(1);
    return {
      stdout: this.stimulus.stdout,
      stderr: this.stimulus.stderr,
      exitCode: this.stimulus.exitCode,
    };
  }
}

/** Composition must use the real App service and this transparent real-SQL observer. */
export async function observeDiagnostic(
  fixture: RawCase,
  writer: PrismaService,
  compose: (observedWriter: PrismaService) => Promise<ConnectorsService>,
  apiKeyId: string,
) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.env.MC_NO_EGRESS !== '1' ||
    url.hostname !== 'mc-diag-pg' ||
    url.username !== 'test' ||
    url.password !== 'test' ||
    url.pathname !== '/diag_df60'
  ) {
    throw new Error('DIAG disposable identity/no-egress authority absent');
  }
  const require = createRequire(process.cwd() + '/package.json');
  const refuse = () => {
    throw new Error('DIAG outbound HTTP refused');
  };
  for (const module of ['node:http', 'node:https']) {
    const network = require(module) as typeof import('node:http');
    network.request = refuse as typeof network.request;
    network.get = refuse as typeof network.get;
  }
  globalThis.fetch = refuse;
  syncBuiltinESMExports();
  if ('expected' in fixture) throw new Error('DIAG expected-data access refused');
  if (fixture.fault === 'crashed-ledger') {
    throw new Error('DIAG actual durable ledger reserve/crash receiving adapter not supplied');
  }
  const inserted: string[] = [];
  // The observer forwards the actual transaction and INSERT; it supplies no synthetic row.
  const observed = new Proxy(writer, {
    get(target, key) {
      if (key !== '$transaction') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          if (fixture.fault === 'read-only-transaction')
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          const request = new Proxy(tx.request, {
            get(delegate, property) {
              const value = Reflect.get(delegate, property);
              if (property !== 'create')
                return typeof value === 'function' ? value.bind(delegate) : value;
              return async (...args: unknown[]) => {
                const row = await Reflect.apply(value, delegate, args);
                if (
                  typeof row !== 'object' ||
                  row === null ||
                  !('id' in row) ||
                  typeof row.id !== 'string'
                ) {
                  throw new Error('DIAG actual INSERT identity absent');
                }
                inserted.push(row.id);
                return row;
              };
            },
          });
          return callback(
            new Proxy(tx, {
              get(object, property) {
                if (property === 'request') return request;
                const value = Reflect.get(object, property);
                return typeof value === 'function' ? value.bind(object) : value;
              },
            }),
          );
        });
    },
  });
  const service = await compose(observed);
  const transport = new RawTransport(fixture);
  service.register(transport);
  const model = 'diag-offline';
  if (fixture.fault === 'circuit') transport.openCircuit(model);
  const response = await service.execute(
    transport.name,
    {
      prompt: 'df60/' + fixture.id + '/' + randomUUID(),
      model,
      maxRetries: fixture.fault === 'second-attempt' ? 1 : 0,
    },
    apiKeyId,
  );
  if (fixture.fault === 'delete-row') {
    await writer.request.deleteMany({ where: { id: { in: inserted }, apiKeyId } });
  }
  // A separate Prisma connection reads only rows whose IDs the actual INSERT returned.
  const reader = new PrismaService();
  try {
    await reader.$connect();
    const queryIds = fixture.fault === 'wrong-read-id' ? [randomUUID()] : inserted;
    const rows = await reader.request.findMany({ where: { id: { in: queryIds }, apiKeyId } });
    return {
      schema: 'MCActualDiagnosticObservation/v1',
      caseId: fixture.id,
      response,
      insertedIds: inserted,
      queryIds,
      committedRows: rows,
      correlationVerified: inserted.length === 1 && rows.length === 1 && rows[0].id === inserted[0],
      transportReceipts: transport.received,
      simulatedPossibleDispatches: transport.possibleDispatches,
      paidProviderCalls: 0,
      naturalReasonDenominator: 0,
      admission: 'NOT_MEASURED',
      ledgerQualified: false,
    };
  } finally {
    await reader.$disconnect();
  }
}
