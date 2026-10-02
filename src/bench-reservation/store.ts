import { Pool, PoolClient } from 'pg';
import { Head, requireBench, ReservationRequest } from './contract';
import { canonical, digest } from './signatures';

type Row = {
  campaign: string;
  journal_id: string;
  sequence: string;
  input_tokens: string;
  output_tokens: string;
  head_sha256: string;
};
export function head(row: Row): Head {
  const values = [row.sequence, row.input_tokens, row.output_tokens].map(Number);
  requireBench(values.every(Number.isSafeInteger), 'counter_not_safe');
  return {
    campaign: row.campaign,
    journal: row.journal_id,
    sequence: values[0],
    aggregate: values,
    head: row.head_sha256,
  };
}
export function same(a: Head, b: Head): boolean {
  return canonical(a) === canonical(b);
}
export function nextHead(current: Head, request: ReservationRequest): Head {
  const aggregate = current.aggregate.map((v, i) => v + request.reserved[i]);
  requireBench(aggregate.every(Number.isSafeInteger), 'counter_overflow');
  return {
    ...current,
    sequence: current.sequence + 1,
    aggregate,
    head: digest(canonical({ previous: current, request, aggregate })),
  };
}
export type DatabaseIdentity = { database: string; role: string; superuser: boolean };
async function identity(pool: Pool): Promise<DatabaseIdentity> {
  const result = await pool.query<DatabaseIdentity>(
    `SELECT current_database() AS database,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`,
  );
  requireBench(result.rows.length === 1, 'database_identity_missing');
  return result.rows[0];
}
export class CheckpointStore {
  constructor(private readonly pool: Pool) {}
  async identity(): Promise<DatabaseIdentity> {
    return identity(this.pool);
  }
  async initialize(initial: Head): Promise<void> {
    await initializeCheckpoint(this.pool, initial);
  }
  async read(campaign: string): Promise<Head> {
    const result = await this.pool.query<Row>('SELECT * FROM bench_checkpoint WHERE campaign=$1', [
      campaign,
    ]);
    requireBench(result.rows.length === 1, 'trusted_checkpoint_missing');
    return head(result.rows[0]);
  }
  async compareAppend(previous: Head, next: Head, request: ReservationRequest): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = on');
      const durability = await client.query<{ fsync: string }>(
        "SELECT current_setting('fsync') AS fsync",
      );
      requireBench(durability.rows[0]?.fsync === 'on', 'postgres_fsync_required');
      const updated = await client.query(
        `UPDATE bench_checkpoint SET sequence=$1,input_tokens=$2,output_tokens=$3,head_sha256=$4
        WHERE campaign=$5 AND journal_id=$6 AND sequence=$7 AND input_tokens=$8 AND output_tokens=$9 AND head_sha256=$10`,
        [
          next.sequence,
          next.aggregate[1],
          next.aggregate[2],
          next.head,
          previous.campaign,
          previous.journal,
          ...previous.aggregate,
          previous.head,
        ],
      );
      requireBench(updated.rowCount === 1, 'checkpoint_cas_refused');
      await client.query(
        `INSERT INTO bench_checkpoint_event(campaign,sequence,attempt,nonce,request,previous_head_sha256,head_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          next.campaign,
          next.sequence,
          request.attempt,
          request.nonce,
          request,
          previous.head,
          next.head,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
export class CampaignStore {
  constructor(private readonly pool: Pool) {}
  async identity(): Promise<DatabaseIdentity> {
    return identity(this.pool);
  }
  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = on');
      const durability = await client.query<{ fsync: string }>(
        "SELECT current_setting('fsync') AS fsync",
      );
      requireBench(durability.rows[0]?.fsync === 'on', 'postgres_fsync_required');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Initialization requires a separately verified Control bootstrap in the
 * service. It never replaces an existing head, even after a lost response.
 */
export async function initializeCheckpoint(pool: Pool, initial: Head): Promise<void> {
  await pool.query(
    `INSERT INTO bench_checkpoint(campaign,journal_id,sequence,input_tokens,output_tokens,head_sha256) VALUES($1,$2,$3,$4,$5,$6)`,
    [initial.campaign, initial.journal, ...initial.aggregate, initial.head],
  );
}
