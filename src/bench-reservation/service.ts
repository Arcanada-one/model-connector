import { createPublicKey, KeyObject } from 'node:crypto';
import { PoolClient } from 'pg';
import {
  CAPS,
  Grant,
  grantSchema,
  requestSchema,
  checkGrant,
  bindRequest,
  requireBench,
  BenchRefused,
  Head,
} from './contract';
import {
  canonical,
  digest,
  publicEd25519,
  signed,
  verifyCaller,
  callerDeadline,
  verifyEnvelope,
} from './signatures';
import { CampaignStore, CheckpointStore, head, nextHead, same } from './store';

const CUSTODY_DOMAIN = 'BENCH-CUSTODY-RESERVATION-v1\n';

export type BenchServiceDependencies = {
  campaign: CampaignStore;
  checkpoint: CheckpointStore;
  issuerPublicKey: KeyObject;
  custodianPrivateKey: KeyObject;
  authArcanaJwks: string;
  now: () => number;
};
/** Source kernel only: not imported into AppModule, no endpoint, env/key loading,
 * model/provider path, live grant issuer, release or default-enabled feature.
 */
export class BenchReservationService {
  constructor(private readonly deps: BenchServiceDependencies) {}
  async provision(signedBootstrap: unknown, callerAccessToken: string): Promise<void> {
    try {
      const payload = verifyEnvelope(
        signedBootstrap,
        this.deps.issuerPublicKey,
        'BENCH-CUSTODY-BOOTSTRAP-v1\n',
      );
      const grant = grantSchema.parse(JSON.parse(payload));
      const lease = this.freshLease(grant, callerAccessToken, 'bench:provision');
      lease.assertFresh();
      this.verifySigner(grant);
      await this.verifyDatabaseSeparation();
      const initial: Head = {
        campaign: grant.campaign,
        journal: grant.journal_id,
        sequence: grant.retained_baseline[0],
        aggregate: [...grant.retained_baseline],
        head: digest(
          canonical({
            original_ledger_sha256: grant.original_ledger_sha256,
            journal: grant.journal_id,
            baseline: grant.retained_baseline,
          }),
        ),
      };
      await this.deps.campaign.transaction(async (client) => {
        lease.assertFresh();
        await client.query(
          `INSERT INTO bench_campaign(campaign,original_ledger_sha256,journal_id,sequence,input_tokens,output_tokens,head_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            grant.campaign,
            grant.original_ledger_sha256,
            grant.journal_id,
            ...grant.retained_baseline,
            initial.head,
          ],
        );
        // Unique original lineage and no upsert/reset. A partially completed
        // provision is frozen against the independent head, never retried as new.
        lease.assertFresh();
        await this.deps.checkpoint.initialize(initial, lease.assertFresh);
        lease.assertFresh();
      }, lease.assertFresh);
      lease.assertFresh();
    } catch {
      throw new BenchRefused('bootstrap_refused_existing_state_preserved');
    }
  }
  async reserve(
    signedGrant: unknown,
    rawRequest: unknown,
    callerAccessToken: string,
    operationDeadline?: number,
  ) {
    try {
      const payload = verifyEnvelope(signedGrant, this.deps.issuerPublicKey, 'BENCH-GRANT-v1\n');
      const grant = grantSchema.parse(JSON.parse(payload));
      const lease = this.freshLease(grant, callerAccessToken, 'bench:reserve', operationDeadline);
      lease.assertFresh();
      this.verifySigner(grant);
      await this.verifyDatabaseSeparation();
      const request = requestSchema.parse(rawRequest);
      bindRequest(grant, request);
      const receipt = await this.deps.campaign.transaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM bench_campaign WHERE campaign=$1 AND original_ledger_sha256=$2 FOR UPDATE`,
          [grant.campaign, grant.original_ledger_sha256],
        );
        lease.assertFresh(); // AFTER the potentially stalled authoritative row lock.
        requireBench(result.rows.length === 1, 'campaign_not_provisioned');
        const previous = head(result.rows[0]);
        requireBench(previous.journal === grant.journal_id, 'different_campaign_journal');
        requireBench(
          previous.aggregate.every((v, i) => v >= grant.retained_baseline[i]),
          'baseline_regressed',
        );
        await this.verifyLocalChain(client, previous, grant);
        requireBench(
          same(previous, await this.deps.checkpoint.read(grant.campaign)),
          'restart_or_rollback_head_mismatch',
        );
        const duplicate = await client.query(
          'SELECT 1 FROM bench_reservation WHERE campaign=$1 AND (attempt=$2 OR nonce=$3)',
          [grant.campaign, grant.attempt, request.nonce],
        );
        requireBench(duplicate.rows.length === 0, 'attempt_or_nonce_already_reserved');
        const next = nextHead(previous, request);
        requireBench(
          next.aggregate.every((v, i) => v <= CAPS[i]),
          'campaign_cap_exhausted',
        );
        // Independently durable CAS consumes the allowance FIRST. If local insert
        // or commit fails, the checkpoint remains ahead; later attempts freeze.
        // No response/commit ambiguity can manufacture a refund or second permit.
        lease.assertFresh();
        await this.deps.checkpoint.compareAppend(previous, next, request, lease.assertFresh);
        lease.assertFresh(); // Committed checkpoint is NEVER released on late refusal.
        await client.query(
          `INSERT INTO bench_reservation(campaign,attempt,nonce,sequence,grant_sha256,request,previous_head_sha256,head_sha256,verdict) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'UNKNOWN_NO_RELEASE')`,
          [
            grant.campaign,
            grant.attempt,
            request.nonce,
            next.sequence,
            digest(payload),
            request,
            previous.head,
            next.head,
          ],
        );
        await client.query(
          `UPDATE bench_campaign SET sequence=$1,input_tokens=$2,output_tokens=$3,head_sha256=$4 WHERE campaign=$5`,
          [next.sequence, next.aggregate[1], next.aggregate[2], next.head, grant.campaign],
        );
        lease.assertFresh();
        return {
          valid_until_unix: lease.deadline,
          request,
          sequence: next.sequence,
          aggregate: next.aggregate,
          previous_head_sha256: previous.head,
          head_sha256: next.head,
          durable_verdict: 'ATOMIC_FSYNC_RESERVED_UNKNOWN_NO_RELEASE',
        };
      }, lease.assertFresh);
      // Signing is after BOTH durable commits. Missing response still spends.
      lease.assertFresh();
      return signed(receipt, this.deps.custodianPrivateKey, CUSTODY_DOMAIN);
    } catch (error) {
      if (error instanceof BenchRefused) throw error;
      // Never return untrusted token/body/SQL/crypto error contents to callers.
      throw new BenchRefused('reservation_refused_unknown_preserved');
    }
  }
  inspectAuthority(signedGrant: unknown, token: string): Grant {
    const grant = grantSchema.parse(
      JSON.parse(verifyEnvelope(signedGrant, this.deps.issuerPublicKey, 'BENCH-GRANT-v1\n')),
    );
    this.freshLease(grant, token, 'bench:reserve').assertFresh();
    this.verifySigner(grant);
    return grant;
  }
  private freshLease(grant: Grant, token: string, scope: string, operationDeadline?: number) {
    const started = this.deps.now();
    requireBench(
      operationDeadline === undefined ||
        (Number.isSafeInteger(operationDeadline) &&
          operationDeadline > started &&
          operationDeadline <= started + 5),
      'operation_deadline_invalid',
    );
    const deadline = Math.min(
      operationDeadline ?? started + 5,
      started + 5,
      grant.expires_unix,
      callerDeadline(token, this.deps.authArcanaJwks, grant, started, scope),
    );
    return {
      deadline,
      assertFresh: () => {
        const now = this.deps.now();
        requireBench(now >= started && now < deadline, 'authenticated_operation_expired');
        checkGrant(grant, now);
        verifyCaller(token, this.deps.authArcanaJwks, grant, now, scope);
      },
    };
  }
  private verifySigner(grant: Grant): void {
    const servicePublic =
      this.deps.custodianPrivateKey.asymmetricKeyType === 'ed25519'
        ? publicEd25519(grant.custodian_public_key).export({ format: 'der', type: 'spki' })
        : null;
    // Distinct issuer/service key custody must also be measured at deployment.
    const actualPublic = createPublicKey(this.deps.custodianPrivateKey).export({ format: 'jwk' });
    requireBench(
      !createPublicKey(this.deps.custodianPrivateKey)
        .export({ format: 'der', type: 'spki' })
        .equals(this.deps.issuerPublicKey.export({ format: 'der', type: 'spki' })),
      'issuer_and_custodian_not_separate',
    );
    requireBench(
      servicePublic !== null &&
        Buffer.from(actualPublic.x ?? '', 'base64url').toString('hex') ===
          grant.custodian_public_key,
      'custodian_key_not_bound',
    );
  }
  private async verifyDatabaseSeparation(): Promise<void> {
    const [primary, checkpoint] = await Promise.all([
      this.deps.campaign.identity(),
      this.deps.checkpoint.identity(),
    ]);
    requireBench(
      primary.database !== checkpoint.database &&
        primary.role !== checkpoint.role &&
        !primary.superuser &&
        !checkpoint.superuser,
      'database_custody_not_separate',
    );
  }
  private async verifyLocalChain(client: PoolClient, current: Head, grant: Grant): Promise<void> {
    const rows = await client.query(
      `SELECT sequence,request,previous_head_sha256,head_sha256 FROM bench_reservation WHERE campaign=$1 ORDER BY sequence`,
      [grant.campaign],
    );
    // Initial state must equal the root-admitted retained baseline and checkpoint.
    let cursor: Head = {
      campaign: grant.campaign,
      journal: grant.journal_id,
      sequence: grant.retained_baseline[0],
      aggregate: [...grant.retained_baseline],
      head: digest(
        canonical({
          original_ledger_sha256: grant.original_ledger_sha256,
          journal: grant.journal_id,
          baseline: grant.retained_baseline,
        }),
      ),
    };
    for (const row of rows.rows) {
      const request = requestSchema.parse(row.request);
      requireBench(
        Number(row.sequence) === cursor.sequence + 1 && row.previous_head_sha256 === cursor.head,
        'torn_or_missing_reservation',
      );
      const next = nextHead(cursor, request);
      requireBench(next.head === row.head_sha256, 'reservation_chain_corrupt');
      cursor = next;
    }
    requireBench(same(cursor, current), 'local_head_not_complete_chain');
  }
}

// No public bootstrap route is exposed. Runtime provisioning must separately
// verify an issuer-signed baseline/checkpoint, preserve original ledger custody
// and prove distinct PostgreSQL privileges; a migration never populates it.
