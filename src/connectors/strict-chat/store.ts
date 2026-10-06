import { isDeepStrictEqual } from 'node:util';
/** reuse: existing billing fingerprint; separate supplier exposure, never customer hold/ledger. */
export interface SupplierPin {
  admission: string;
  rate: string;
  checkpoint: string;
  capability: string;
  source: string;
  deployment: string;
  encoder: string;
  hard_output: string;
  units: string;
  scale: number;
}
export interface IntentRecord {
  tenant: string;
  intent: string;
  attempt: string;
  generation: string;
  digest: string;
  model: string;
  connector: string;
  state: 'dispatch_started' | 'completed' | 'uncertain';
  exposure: SupplierPin;
  receipt: Record<string, unknown> | null;
}
export interface StrictIntentStore {
  begin(row: IntentRecord): Promise<{ inserted: boolean; row: IntentRecord }>;
  read(tenant: string, intent: string): Promise<IntentRecord | null>;
  finish(
    row: IntentRecord,
    state: 'completed' | 'uncertain',
    receipt: Record<string, unknown>,
  ): Promise<boolean>;
}
/** Existing custodian supplies restricted authenticated connection; never creates pool/migrates. */
export interface StrictSql {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
function decode(row: Record<string, unknown>): IntentRecord {
  return {
    tenant: String(row.api_key_id),
    intent: String(row.intent_key),
    attempt: String(row.attempt),
    generation: String(row.generation),
    digest: String(row.digest),
    model: String(row.model),
    connector: String(row.connector),
    state: row.state as IntentRecord['state'],
    exposure: row.exposure as SupplierPin,
    receipt: row.receipt as IntentRecord['receipt'],
  };
}
export class SqlStrictIntentStore implements StrictIntentStore {
  constructor(private readonly sql: StrictSql) {}
  async begin(row: IntentRecord) {
    const { rows } = await this.sql.query(
      `INSERT INTO strict_supplier_intent
      (api_key_id,intent_key,attempt,generation,digest,model,connector,state,exposure)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'dispatch_started',$8::jsonb)
      ON CONFLICT (api_key_id,intent_key) DO NOTHING RETURNING *`,
      [
        row.tenant,
        row.intent,
        row.attempt,
        row.generation,
        row.digest,
        row.model,
        row.connector,
        JSON.stringify(row.exposure),
      ],
    );
    // Separate committed readback is mandatory. A lost insert ACK leaves durable dispatch_started.
    const visible = await this.read(row.tenant, row.intent);
    if (!visible) throw new Error('strict-commit-unknown');
    return { inserted: rows.length === 1, row: visible };
  }
  async read(tenant: string, intent: string) {
    const { rows } = await this.sql.query(
      'SELECT * FROM strict_supplier_intent WHERE api_key_id=$1 AND intent_key=$2',
      [tenant, intent],
    );
    return rows.length === 1 ? decode(rows[0]) : null;
  }
  async finish(
    row: IntentRecord,
    state: 'completed' | 'uncertain',
    receipt: Record<string, unknown>,
  ) {
    const { rows } = await this.sql.query(
      `UPDATE strict_supplier_intent SET state=$4,receipt=$5::jsonb
      WHERE api_key_id=$1 AND intent_key=$2 AND digest=$3 AND state='dispatch_started' RETURNING *`,
      [row.tenant, row.intent, row.digest, state, JSON.stringify(receipt)],
    );
    const visible = await this.read(row.tenant, row.intent);
    return rows.length === 1 && isDeepStrictEqual(visible, { ...row, state, receipt });
  }
}
