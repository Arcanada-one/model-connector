import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const client = new Client({ connectionString: databaseUrl });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function expectRejected(sql, params, expectedConstraint) {
  await client.query('SAVEPOINT expected_rejection');
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
    if (error?.code !== '23514' || error?.constraint !== expectedConstraint) {
      throw error;
    }
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
  throw new Error(`expected PostgreSQL constraint ${expectedConstraint} to reject the mutation`);
}

await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO "ApiKey" ("id", "name", "keyHash") VALUES ($1, $2, $3)`, [
    'db-contract-api-key',
    'first-dispatch-db-contract',
    'db-contract-key-hash',
  ]);

  const measurement = {
    version: 'first-dispatch-measurement/v0',
    corpusId: 'db-contract-corpus',
    caseId: 'db-contract-case',
    roleId: 'developer',
    taskClassId: 'code-change',
    commandId: 'implement',
    replayIndex: 1,
    variant: 'compiled',
    adapterBoundary: 'arcana-agent-system/driver/first-dispatch-v0',
  };
  const reservationValues = [
    'db-contract-observation',
    'db-contract-api-key',
    'a'.repeat(64),
    measurement,
    'openrouter',
    'bounded-model',
    'b'.repeat(64),
    321,
    'model-connector/service/pre-adapter-v0',
    'MODEL_CONNECTOR_POSTGRESQL',
    'RESERVED_PRE_ADAPTER_OBSERVATION',
    'NOT_AUTHORIZED',
    'reserved',
  ];
  await client.query(
    `INSERT INTO "FirstDispatchObservation" (
      "id", "apiKeyId", "observationKeySha256", "measurement", "connector",
      "requestedModel", "requestPayloadDigestSha256", "requestPayloadBytes",
      "observationBoundary", "persistence", "evidenceStatus", "authorization",
      "state", "updatedAt"
    ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP)`,
    reservationValues,
  );

  const observedMutation = `UPDATE "FirstDispatchObservation" SET
    "state" = 'observed', "connectorResponseId" = 'connector-response-1',
    "observedModel" = 'bounded-model', "inputTokens" = 17, "outputTokens" = 5,
    "totalTokens" = 22, "costUsd" = 0.0000123, "latencyMs" = 42,
    "outcome" = 'error', "usageSource" = $1, "receipt" = $2::jsonb,
    "receiptDigestSha256" = $3,
    "evidenceStatus" = 'PERSISTED_PRE_ADAPTER_OBSERVATION',
    "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'db-contract-observation'`;
  const receipt = {
    observationId: 'db-contract-observation',
    authorization: 'NOT_AUTHORIZED',
    usage: { source: 'CONNECTOR_RESPONSE_UNVERIFIED', costUsd: 0.0000123 },
    receiptDigestSha256: 'c'.repeat(64),
  };

  await expectRejected(
    observedMutation,
    [null, receipt, 'c'.repeat(64)],
    'FirstDispatchObservation_state_check',
  );
  await expectRejected(
    `UPDATE "FirstDispatchObservation" SET
      "state" = 'indeterminate', "failureStage" = NULL,
      "evidenceStatus" = 'INDETERMINATE_PROVIDER_OR_PERSISTENCE_OUTCOME',
      "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'db-contract-observation'`,
    [],
    'FirstDispatchObservation_state_check',
  );

  await client.query(observedMutation, ['CONNECTOR_RESPONSE_UNVERIFIED', receipt, 'c'.repeat(64)]);
  const result = await client.query(
    `SELECT "receipt", "costUsd"::text AS "costUsd", "state"
       FROM "FirstDispatchObservation" WHERE "id" = $1`,
    ['db-contract-observation'],
  );
  const row = result.rows[0];
  if (canonicalJson(row.receipt) !== canonicalJson(receipt)) {
    throw new Error('JSONB receipt did not round-trip losslessly');
  }
  if (row.costUsd !== '0.000012300000' || row.state !== 'observed') {
    throw new Error(`unexpected persisted decimal/state: ${row.costUsd}/${row.state}`);
  }

  await client.query('SAVEPOINT immutable_rejection');
  try {
    await client.query(`UPDATE "FirstDispatchObservation" SET "latencyMs" = 43 WHERE "id" = $1`, [
      'db-contract-observation',
    ]);
    throw new Error('expected immutable observed row update to fail');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT immutable_rejection');
    if (error?.code !== 'P0001') throw error;
  }

  await client.query('ROLLBACK');
  console.log('first-dispatch PostgreSQL contract: PASS');
} finally {
  await client.end();
}
