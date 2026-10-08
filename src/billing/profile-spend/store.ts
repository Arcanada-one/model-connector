import { HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { intentPayloadFingerprint } from '../intent';
import { ProfileSpendError, type SpendPlan } from './plan';
import { moneyUnits, utcPeriods } from './money';
import { spendEventSchema, spendPageSchema, spendCursorSchema, type SpendEvent } from './envelope';

export interface SpendSql {
  query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface SpendDatabase extends SpendSql {
  transaction<T>(fn: (sql: SpendSql) => Promise<T>): Promise<T>;
}
export interface SpendObservation {
  inputTokens: number | null;
  outputTokens: number | null;
  servedModel: string | null;
  providerRequestId: string | null;
  responseSeen: boolean;
  observedUnits: bigint | null;
  verified: boolean;
  pauseProfile: boolean;
  reason: string | null;
}
const hash = (value: unknown) => intentPayloadFingerprint(value);
export class SqlProfileSpendStore {
  constructor(private readonly db: SpendDatabase) {}
  async reserve(p: SpendPlan): Promise<string> {
    return this.db.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO profile_spend_account(id,owner_profile_id,currency,profile_bindings)
        VALUES($1,$2,'USD',$3::jsonb) ON CONFLICT DO NOTHING`,
        [p.accountId, p.ownerProfileId, JSON.stringify(p.profileBindings)],
      );
      const account = (
        await sql.query('SELECT * FROM profile_spend_account WHERE id=$1 FOR UPDATE', [p.accountId])
      ).rows[0];
      if (!account || account.owner_profile_id !== p.ownerProfileId)
        throw new ProfileSpendError('profile_spend_account_binding');
      const bindings = account.profile_bindings as Record<string, string>;
      for (const [provider, id] of Object.entries(bindings))
        if (p.profileBindings[provider] !== id)
          throw new ProfileSpendError('profile_spend_profile_binding');
      await sql.query('UPDATE profile_spend_account SET profile_bindings=$2::jsonb WHERE id=$1', [
        p.accountId,
        JSON.stringify({ ...bindings, ...p.profileBindings }),
      ]);
      await sql.query(
        `INSERT INTO profile_spend_key_binding(api_key_id,account_id) VALUES($1,$2)
        ON CONFLICT(api_key_id) DO NOTHING`,
        [p.clientKeyId, p.accountId],
      );
      const key = (
        await sql.query('SELECT account_id FROM profile_spend_key_binding WHERE api_key_id=$1', [
          p.clientKeyId,
        ])
      ).rows[0];
      if (key?.account_id !== p.accountId) throw new ProfileSpendError('profile_spend_key_binding');
      const existing = (
        await sql.query(
          'SELECT id,digest FROM profile_spend_call WHERE account_id=$1 AND run_id=$2 AND intent_key=$3',
          [p.accountId, p.runId, p.intentKey],
        )
      ).rows[0];
      if (existing)
        throw new ProfileSpendError(
          existing.digest === p.digest
            ? 'profile_spend_existing_intent'
            : 'profile_spend_intent_conflict',
          HttpStatus.CONFLICT,
        );
      if ((account.paused_profiles as string[]).includes(p.profileId))
        throw new ProfileSpendError('profile_spend_profile_paused');
      const uncertain = (
        await sql.query(
          `SELECT id FROM profile_spend_call WHERE account_id=$1 AND run_id=$2 AND state='uncertain' LIMIT 1`,
          [p.accountId, p.runId],
        )
      ).rows;
      if (uncertain.length) throw new ProfileSpendError('profile_spend_run_paused');
      const policyHash = hash(p.policy),
        tariffHash = hash(p.tariff);
      const previous = (
        await sql.query(
          `SELECT policy_revision,policy_hash,profile_id,model,tariff_revision,tariff_hash
        FROM profile_spend_call WHERE account_id=$1 AND (policy_revision=$2 OR (profile_id=$3 AND model=$4 AND tariff_revision=$5))`,
          [p.accountId, p.policy.revision, p.profileId, p.model, p.tariff.revision],
        )
      ).rows;
      if (
        previous.some(
          (r) =>
            (r.policy_revision === p.policy.revision && r.policy_hash !== policyHash) ||
            (r.profile_id === p.profileId &&
              r.model === p.model &&
              r.tariff_revision === p.tariff.revision &&
              r.tariff_hash !== tariffHash),
        )
      )
        throw new ProfileSpendError('profile_spend_revision_changed');
      const occupancy = (
        await sql.query(
          `SELECT count(*) AS count FROM profile_spend_call WHERE account_id=$1 AND state IN ('reserved','claimed','dispatch_started','uncertain')`,
          [p.accountId],
        )
      ).rows[0];
      if (Number(occupancy.count) >= p.policy.client.maxConcurrent)
        throw new ProfileSpendError(
          'profile_spend_concurrency_exceeded',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const periods = utcPeriods(p.at);
      const caps: Array<{
        scope: string;
        profile: string | null;
        period: string;
        start: Date;
        end: Date;
        limit: bigint;
        run: string | null;
      }> = [
        {
          scope: 'prime_currency',
          profile: null,
          period: 'day',
          start: periods.dayStart,
          end: periods.dayEnd,
          limit: moneyUnits(p.policy.client.dailyLimit),
          run: null,
        },
        {
          scope: 'prime_currency',
          profile: null,
          period: 'month',
          start: periods.monthStart,
          end: periods.monthEnd,
          limit: moneyUnits(p.policy.client.monthlyLimit),
          run: null,
        },
        {
          scope: 'provider_profile',
          profile: p.profileId,
          period: 'day',
          start: periods.dayStart,
          end: periods.dayEnd,
          limit: moneyUnits(p.policy.providers[p.provider].dailyLimit),
          run: null,
        },
        {
          scope: 'provider_profile',
          profile: p.profileId,
          period: 'month',
          start: periods.monthStart,
          end: periods.monthEnd,
          limit: moneyUnits(p.policy.providers[p.provider].monthlyLimit),
          run: null,
        },
        {
          scope: 'run',
          profile: null,
          period: 'run',
          start: new Date(p.policy.effectiveFrom),
          end: new Date(p.policy.effectiveUntil),
          limit: moneyUnits(p.policy.client.runLimit),
          run: p.runId,
        },
      ];
      const admissionCaps: SpendEvent['attempt']['admissionCaps'] = [];
      for (const cap of caps) {
        // Old unreconciled exposure carries into a new safety interval exactly once.
        const result = (
          await sql.query(
            `SELECT COALESCE(sum(charged_nano),0) AS exposure FROM profile_spend_call
          WHERE account_id=$1 AND ($2::text IS NULL OR profile_id=$2) AND ($3::text IS NULL OR run_id=$3)
          AND ((admitted_at >= $4 AND admitted_at < $5) OR (admitted_at < $4 AND reconciliation='NOT_MEASURED'))`,
            [p.accountId, cap.profile, cap.run, cap.start, cap.end],
          )
        ).rows[0];
        const next = BigInt(String(result.exposure)) + p.reserve;
        if (next > cap.limit)
          throw new ProfileSpendError('profile_spend_cap_exceeded', HttpStatus.TOO_MANY_REQUESTS);
        let outboxId: string | null = null;
        if (cap.limit > 0n && next * 5n >= cap.limit * 4n) {
          await sql.query(
            `INSERT INTO profile_spend_alert_outbox(account_id,scope_key,period,period_start,period_end,policy_revision)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [
              p.accountId,
              cap.scope + ':' + (cap.profile ?? cap.run ?? 'USD'),
              cap.period,
              cap.start,
              cap.end,
              p.policy.revision,
            ],
          );
          const outbox = (
            await sql.query(
              `SELECT id FROM profile_spend_alert_outbox WHERE account_id=$1 AND scope_key=$2 AND period=$3 AND period_start=$4 AND period_end=$5 AND policy_revision=$6`,
              [
                p.accountId,
                cap.scope + ':' + (cap.profile ?? cap.run ?? 'USD'),
                cap.period,
                cap.start,
                cap.end,
                p.policy.revision,
              ],
            )
          ).rows[0];
          outboxId = String(outbox.id);
        }
        admissionCaps.push({
          authority: 'mc_client',
          scope:
            cap.scope === 'prime_currency'
              ? 'mc_client_currency'
              : (cap.scope as 'provider_profile' | 'run'),
          profileId: cap.profile,
          runId: cap.run,
          period: cap.period as 'day' | 'month' | 'run',
          from: cap.start.toISOString(),
          to: cap.end.toISOString(),
          observedAt: p.at.toISOString(),
          limitNano: cap.limit.toString(),
          exposureNano: next.toString(),
          policyRevision: p.policy.revision,
          outboxId,
        });
      }
      const id = randomUUID();
      await sql.query(
        `INSERT INTO profile_spend_call(id,account_id,api_key_id,intent_key,digest,profile_id,provider,credential_ref,credential_version,
        model,run_id,nodes,currency,state,reserve_nano,charged_nano,policy_revision,policy_hash,tariff_revision,tariff_hash,snapshot,admitted_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'USD','reserved',$13,$13,$14,$15,$16,$17,$18::jsonb,$19)`,
        [
          id,
          p.accountId,
          p.clientKeyId,
          p.intentKey,
          p.digest,
          p.profileId,
          p.provider,
          p.credentialRef,
          p.credentialVersion,
          p.model,
          p.runId,
          p.nodes,
          p.reserve.toString(),
          p.policy.revision,
          policyHash,
          p.tariff.revision,
          tariffHash,
          JSON.stringify({
            policy: p.policy,
            tariff: p.tariff,
            admissionCaps,
            operationId: p.operationId,
            routeEpoch: p.routeEpoch,
            qualification: {
              policy: p.policy,
              tariff: p.tariff,
              inputTokenCeiling: p.inputBound,
              outputTokenCeiling: p.outputBound,
              payloadByteCeiling: p.tariff.maxPayloadBytes,
              requestBytes: p.requestBytes,
            },
          }),
          p.at,
        ],
      );
      await this.event(sql, id, 'reservation', {
        reserveNano: p.reserve.toString(),
        profileId: p.profileId,
      });
      return id;
    });
  }
  async claim(id: string) {
    await this.transition(id, 'reserved', 'claimed', false);
  }
  async markEgress(id: string) {
    await this.transition(id, 'claimed', 'dispatch_started', true);
  }
  private async transition(id: string, from: string, to: string, egress: boolean) {
    await this.db.transaction(async (sql) => {
      const call = (await sql.query('SELECT account_id FROM profile_spend_call WHERE id=$1', [id]))
        .rows[0];
      if (!call)
        throw new ProfileSpendError('profile_spend_claim_unavailable', HttpStatus.CONFLICT);
      await sql.query('SELECT id FROM profile_spend_account WHERE id=$1 FOR UPDATE', [
        call.account_id,
      ]);
      const result = await sql.query(
        `UPDATE profile_spend_call SET state=$3,egress_started=egress_started OR $4
        WHERE id=$1 AND state=$2 RETURNING id`,
        [id, from, to, egress],
      );
      if (result.rows.length !== 1)
        throw new ProfileSpendError('profile_spend_claim_unavailable', HttpStatus.CONFLICT);
      await this.event(sql, id, to, {});
    });
  }
  async finish(id: string, p: SpendPlan, o: SpendObservation) {
    await this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM profile_spend_account WHERE id=$1 FOR UPDATE', [p.accountId]);
      const state = o.verified ? 'completed' : 'uncertain';
      const result = await sql.query(
        `UPDATE profile_spend_call SET state=$2,input_tokens=$3,output_tokens=$4,
        served_model=$5,provider_request_id=$6,response_seen=$7,observed_nano=$8,
        charged_nano=GREATEST(reserve_nano,COALESCE($8::numeric,0)),finished_at=$9,reason_code=$10
        WHERE id=$1 AND account_id=$11 AND api_key_id=$12 AND profile_id=$13
        AND state IN ('reserved','claimed','dispatch_started') RETURNING id`,
        [
          id,
          state,
          o.inputTokens,
          o.outputTokens,
          o.servedModel,
          o.providerRequestId,
          o.responseSeen,
          o.observedUnits?.toString() ?? null,
          new Date(),
          o.reason,
          p.accountId,
          p.clientKeyId,
          p.profileId,
        ],
      );
      if (result.rows.length !== 1)
        throw new ProfileSpendError('profile_spend_settlement_unavailable');
      if (o.pauseProfile)
        await sql.query(
          `UPDATE profile_spend_account SET paused_profiles=array_append(paused_profiles,$2)
        WHERE id=$1 AND NOT($2=ANY(paused_profiles))`,
          [p.accountId, p.profileId],
        );
      await this.event(sql, id, 'observation', {
        state,
        inputTokens: o.inputTokens,
        outputTokens: o.outputTokens,
        observedNano: o.observedUnits?.toString() ?? null,
        reason: o.reason,
      });
    });
  }
  async readEvents(accountId: string, ownerProfileId: string, after: string, limit = 100) {
    if (
      !spendCursorSchema.safeParse(after).success ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new ProfileSpendError('profile_spend_cursor_invalid', 400);
    return this.db.transaction(async (sql) => {
      const account = (
        await sql.query(
          'SELECT * FROM profile_spend_account WHERE id=$1 AND owner_profile_id=$2 FOR SHARE',
          [accountId, ownerProfileId],
        )
      ).rows[0];
      if (!account) throw new ProfileSpendError('profile_spend_account_unavailable', 404);
      if (BigInt(after) > BigInt(String(account.event_sequence)))
        throw new ProfileSpendError('profile_spend_cursor_ahead', 409);
      const rows = (
        await sql.query(
          'SELECT sequence,data FROM profile_spend_event WHERE account_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
          [accountId, after, limit],
        )
      ).rows;
      return spendPageSchema.parse({
        schema: 'MCProfileSpendEvents/v1',
        ledgerId: account.ledger_id,
        accountId,
        ownerProfileId,
        after,
        through: rows.length ? String(rows.at(-1)!.sequence) : after,
        watermark: String(account.event_sequence),
        observedAt: new Date().toISOString(),
        events: rows.map((r) => r.data),
      });
    });
  }
  private async event(sql: SpendSql, id: string, kind: string, _data: unknown) {
    const call = (
      await sql.query(
        'SELECT c.*,a.owner_profile_id FROM profile_spend_call c JOIN profile_spend_account a ON a.id=c.account_id WHERE c.id=$1',
        [id],
      )
    ).rows[0];
    const sequence = (
      await sql.query(
        'UPDATE profile_spend_account SET event_sequence=event_sequence+1 WHERE id=$1 RETURNING event_sequence',
        [call.account_id],
      )
    ).rows[0];
    const nullableString = (v: unknown) => (v == null ? null : String(v));
    const admittedAt =
      call.admitted_at instanceof Date ? call.admitted_at.toISOString() : String(call.admitted_at);
    const snapshot = call.snapshot as {
      admissionCaps: unknown;
      operationId: string;
      routeEpoch: string;
      qualification: unknown;
    };
    const data = spendEventSchema.parse({
      sequence: String(sequence.event_sequence),
      kind,
      observedAt: new Date().toISOString(),
      attempt: {
        id: String(call.id),
        accountId: String(call.account_id),
        ownerProfileId: String(call.owner_profile_id),
        clientKeyId: String(call.api_key_id),
        profileId: String(call.profile_id),
        provider: String(call.provider),
        model: String(call.model),
        runId: String(call.run_id),
        operationId: snapshot.operationId,
        routeEpoch: snapshot.routeEpoch,
        qualification: snapshot.qualification,
        servedModel: nullableString(call.served_model),
        providerRequestId: nullableString(call.provider_request_id),
        intentKey: String(call.intent_key),
        digest: String(call.digest),
        credentialRef: String(call.credential_ref),
        credentialVersion: String(call.credential_version),
        admittedAt,
        nodes: call.nodes,
        state: call.state,
        currency: call.currency,
        reserveNano: String(call.reserve_nano),
        observedNano: nullableString(call.observed_nano),
        heldNano: String(call.charged_nano),
        inputTokens: nullableString(call.input_tokens),
        outputTokens: nullableString(call.output_tokens),
        reconciliation: call.reconciliation,
        policyRevision: String(call.policy_revision),
        policyHash: String(call.policy_hash),
        tariffRevision: String(call.tariff_revision),
        tariffHash: String(call.tariff_hash),
        admissionCaps: snapshot.admissionCaps,
      },
    });
    await sql.query(
      'INSERT INTO profile_spend_event(account_id,sequence,call_id,kind,data) VALUES($1,$2,$3,$4,$5::jsonb)',
      [call.account_id, sequence.event_sequence, id, kind, JSON.stringify(data)],
    );
  }
}
