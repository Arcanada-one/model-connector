import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { SqlProfileSpendStore, type SpendDatabase, type SpendSql } from './store';
import type { SpendPlan } from './plan';
import { moneyUnits } from './money';
import { PrimeExposureEnvelope, type EnvelopeHold } from './envelope-mirror';
import { spendPageSchema, type SpendPage } from './envelope';
import { ProfileSpendError } from './plan';
import { assertSpendReliance } from './reliance';
import { spendQualificationSchema } from './envelope';
import { buildDeepSeekRequestBody } from '../../connectors/deepseek/deepseek.connector';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuthGuard } from '../../auth/auth.guard';
import type { AuthService } from '../../auth/auth.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PolicyService } from '../../policy/policy.service';
import { ProfileSpendEventsService } from './events.service';
import { ProfileSpendEventsController } from './events.controller';

// This fixture starts its OWN cluster over a private Unix socket. No service,
// credential or provider connection is accepted from the host environment.
describe('durable supplier admission (isolated PostgreSQL)', () => {
  let root: string;
  let pool: Pool;
  const bin = '/usr/lib/postgresql/16/bin';
  const database = (mutate = false, rendezvous?: () => Promise<void>): SpendDatabase => ({
    query: async (sql, values) => pool.query(sql, values),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const sql: SpendSql = {
          query: async (text, values) => {
            // A falsification control removes ALL account serialization, not
            // only the explicit lock while leaving the binding UPDATE lock.
            if (mutate && text.startsWith('UPDATE profile_spend_account SET profile_bindings'))
              return { rows: [] };
            const result = await client.query(
              mutate ? text.replace(' FOR UPDATE', '') : text,
              values,
            );
            if (
              mutate &&
              text.includes('sum(charged_nano)') &&
              values[1] === null &&
              values[2] === null &&
              (values[4] as Date).toISOString() === '2026-10-09T00:00:00.000Z'
            )
              await rendezvous!();
            return result;
          },
        };
        const result = await fn(sql);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  });
  const plan = (intent: string, changes: Partial<SpendPlan> = {}): SpendPlan => {
    const p: SpendPlan = {
      accountId: 'account-a',
      ownerProfileId: 'client-a',
      clientKeyId: 'key-a',
      profileId: 'allocated-deepseek',
      provider: 'deepseek',
      credentialRef: 'opaque-ref',
      credentialVersion: 'v1',
      intentKey: intent,
      digest: intent,
      model: 'fixture-model',
      runId: intent,
      operationId: intent,
      routeEpoch: 'fixture-epoch-1',
      requestBytes: 100,
      nodes: ['node-a', 'node-b'],
      at: new Date('2026-10-08T12:00:00Z'),
      policy: {
        mode: 'strict',
        revision: 'policy-1',
        currency: 'USD',
        effectiveFrom: '2026-01-01T00:00:00Z',
        effectiveUntil: '2027-01-01T00:00:00Z',
        client: { dailyLimit: '1', monthlyLimit: '1', runLimit: '1', maxConcurrent: 64 },
        providers: {
          deepseek: {
            profileId: 'allocated-deepseek',
            dailyLimit: '1',
            monthlyLimit: '1',
            models: {},
          },
        },
      },
      tariff: {
        revision: 'tariff-1',
        sourceRef: 'fixture:synthetic',
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2027-01-01T00:00:00Z',
        inputPerMTok: '300000',
        outputPerMTok: '300000',
        inputTokenBound: 1,
        maxOutputTokens: 1,
        maxPayloadBytes: 512,
        boundAuthority: 'synthetic-only',
        capability: {
          id: 'fixture-capability',
          sha256: 'a'.repeat(64),
          provider: 'deepseek',
          model: 'fixture-model',
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: '2027-01-01T00:00:00Z',
          inputTokenCeiling: 10,
          outputTokenCeiling: 10,
          payloadByteCeiling: 512,
        },
      },
      reserve: moneyUnits('0.6'),
      inputBound: 1,
      outputBound: 1,
      request: { prompt: 'private-prompt-canary-only', model: 'fixture-model' },
      profileBindings: { deepseek: 'allocated-deepseek' },
      ...changes,
    };
    p.policy.providers.deepseek.models[p.model] = p.tariff;
    return p;
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'spg-'));
    execFileSync(join(bin, 'initdb'), ['-D', join(root, 'data'), '-A', 'trust', '--no-locale'], {
      stdio: 'pipe',
    });
    execFileSync(
      join(bin, 'pg_ctl'),
      [
        '-D',
        join(root, 'data'),
        '-l',
        join(root, 'server.log'),
        '-o',
        `-k ${root} -c listen_addresses=''`,
        '-w',
        'start',
      ],
      { stdio: 'pipe' },
    );
    pool = new Pool({
      host: root,
      user: userInfo().username,
      database: 'postgres',
      max: 12,
    });
    await pool.query(
      readFileSync(
        join(process.cwd(), 'prisma/migrations/20261008123000_profile_spend_ledger/migration.sql'),
        'utf8',
      ),
    );
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE profile_spend_account CASCADE');
  });
  afterAll(async () => {
    await pool?.end();
    if (root) {
      execFileSync(
        join(bin, 'pg_ctl'),
        ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'],
        { stdio: 'pipe' },
      );
      rmSync(root, { recursive: true });
    }
  });
  const race = async (store: SqlProfileSpendStore, count = 8) => {
    const dispatched: string[] = [];
    const results = await Promise.allSettled(
      Array.from({ length: count }, async (_, i) => {
        const id = await store.reserve(plan(`race-${i}`));
        await store.claim(id);
        await store.markEgress(id);
        dispatched.push(id); // Synthetic egress seam, never an actual provider.
      }),
    );
    return { results, dispatched };
  };
  it('serializes concurrent exposure: one admission, seven 429, one possible egress', async () => {
    const { results, dispatched } = await race(new SqlProfileSpendStore(database()));
    expect(dispatched).toHaveLength(1);
    const denied = results.filter((r) => r.status === 'rejected');
    expect(denied).toHaveLength(7);
    for (const r of denied) if (r.status === 'rejected') expect(r.reason.getStatus()).toBe(429);
    const durable = await pool.query('SELECT charged_nano,state FROM profile_spend_call');
    expect(durable.rows).toEqual([{ charged_nano: '600000000', state: 'dispatch_started' }]);
    expect((await pool.query('SELECT count(*) FROM profile_spend_event')).rows[0].count).toBe('3');
  });
  it('atomicity-removal control makes the cap assertion RED under a forced schedule', async () => {
    // Seed bindings before racing, to ensure insertion cannot accidentally
    // serialize the mutant and give a false positive.
    await pool.query(
      "INSERT INTO profile_spend_account(id,owner_profile_id,currency,profile_bindings) VALUES('account-a','client-a','USD','{\"deepseek\":\"allocated-deepseek\"}')",
    );
    await pool.query("INSERT INTO profile_spend_key_binding VALUES('key-a','account-a')");
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rendezvous = async () => {
      if (++arrived === 4) release();
      await barrier;
    };
    const { dispatched } = await race(new SqlProfileSpendStore(database(true, rendezvous)), 4);
    expect(dispatched).toHaveLength(4);
    expect(() => expect(dispatched).toHaveLength(1)).toThrow();
  });
  it('retains uncertain exposure over UTC rollover and across store recreation', async () => {
    const p = plan('old');
    const store = new SqlProfileSpendStore(database());
    const id = await store.reserve(p);
    await store.claim(id);
    await store.markEgress(id);
    await store.finish(id, p, {
      inputTokens: null,
      outputTokens: null,
      servedModel: null,
      providerRequestId: null,
      responseSeen: false,
      observedUnits: null,
      verified: false,
      pauseProfile: false,
      reason: 'unknown_transport',
    });
    const next = plan('new', { at: new Date('2026-11-01T00:00:00Z') });
    await expect(new SqlProfileSpendStore(database()).reserve(next)).rejects.toMatchObject({
      status: 429,
    });
    const row = (
      await pool.query(
        'SELECT charged_nano,input_tokens,output_tokens,reconciliation FROM profile_spend_call',
      )
    ).rows[0];
    expect(row).toEqual({
      charged_nano: '600000000',
      input_tokens: null,
      output_tokens: null,
      reconciliation: 'NOT_MEASURED',
    });
  });
  it('allows only one durable claim and never creates a second egress intent', async () => {
    const store = new SqlProfileSpendStore(database());
    const id = await store.reserve(plan('same'));
    const claims = await Promise.allSettled([store.claim(id), store.claim(id)]);
    expect(claims.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(store.reserve(plan('same'))).rejects.toMatchObject({ status: 409 });
    await expect(store.reserve(plan('same', { digest: 'changed' }))).rejects.toMatchObject({
      status: 409,
    });
    expect((await pool.query('SELECT count(*) FROM profile_spend_call')).rows[0].count).toBe('1');
  });
  it.each([false, true])(
    'refuses rotated-key logical replay (changed payload=%s) without redispatch',
    async (changed) => {
      const p = plan('rotation-intent', { runId: 'stable-run' });
      p.policy.client.dailyLimit = p.policy.client.monthlyLimit = p.policy.client.runLimit = '100';
      p.policy.providers.deepseek.dailyLimit = p.policy.providers.deepseek.monthlyLimit = '100';
      const store = new SqlProfileSpendStore(database());
      const id = await store.reserve(p);
      await store.claim(id);
      await store.markEgress(id);
      let dispatches = 1;
      const rotated = {
        ...p,
        clientKeyId: 'rotated-key',
        digest: changed ? 'changed-payload' : p.digest,
      };
      let rejection: unknown;
      try {
        const replayId = await store.reserve(rotated);
        await store.claim(replayId);
        await store.markEgress(replayId);
        dispatches++;
      } catch (err) {
        rejection = err;
      }
      expect(rejection).toMatchObject({
        status: 409,
        response: {
          error: changed ? 'profile_spend_intent_conflict' : 'profile_spend_existing_intent',
        },
      });
      expect(dispatches).toBe(1);
      expect((await pool.query('SELECT count(*) FROM profile_spend_call')).rows[0].count).toBe('1');
      expect(
        (await pool.query("SELECT count(*) FROM profile_spend_event WHERE kind='dispatch_started'"))
          .rows[0].count,
      ).toBe('1');
      expect(
        (await pool.query('SELECT api_key_id FROM profile_spend_call WHERE id=$1', [id])).rows[0]
          .api_key_id,
      ).toBe('key-a');
    },
  );
  it('keeps the same operation label in a distinct run independent', async () => {
    const p = plan('operation-label', { runId: 'first-run', reserve: moneyUnits('0.1') });
    const store = new SqlProfileSpendStore(database());
    await store.reserve(p);
    await store.reserve({ ...p, runId: 'second-run' });
    expect((await pool.query('SELECT count(*) FROM profile_spend_call')).rows[0].count).toBe('2');
  });
  it('refuses rotated-key rebinding of the stable owner to a fresh budget bucket', async () => {
    const store = new SqlProfileSpendStore(database());
    await store.reserve(plan('original-bucket'));
    await expect(
      store.reserve(
        plan('fresh-bucket', { accountId: 'reset-bucket', clientKeyId: 'rotated-key' }),
      ),
    ).rejects.toMatchObject({ status: 503, response: { error: 'profile_spend_account_binding' } });
    expect((await pool.query('SELECT count(*) FROM profile_spend_account')).rows[0].count).toBe(
      '1',
    );
    expect((await pool.query('SELECT count(*) FROM profile_spend_call')).rows[0].count).toBe('1');
  });
  const parityPlan = (intent: string, changes: Partial<SpendPlan> = {}) => {
    const p = plan(intent, { runId: 'parity-run', reserve: moneyUnits('100'), ...changes });
    p.tariff.inputPerMTok = p.tariff.outputPerMTok = '5000000';
    p.tariff.inputTokenBound = p.tariff.maxOutputTokens = p.inputBound = p.outputBound = 10;
    p.request = { ...p.request, extra: { max_tokens: 10 } };
    p.requestBytes = Buffer.byteLength(JSON.stringify(buildDeepSeekRequestBody(p.request)));
    p.policy.providers.deepseek.models[p.model] = p.tariff;
    p.policy.client.dailyLimit = p.policy.client.monthlyLimit = p.policy.client.runLimit = '250';
    p.policy.providers.deepseek.dailyLimit = p.policy.providers.deepseek.monthlyLimit = '250';
    return p;
  };
  const finishParity = async (store: SqlProfileSpendStore, p: SpendPlan, verified = true) => {
    const id = await store.reserve(p);
    await store.claim(id);
    await store.markEgress(id);
    await store.finish(id, p, {
      inputTokens: verified ? 1 : null,
      outputTokens: verified ? 1 : null,
      servedModel: verified ? p.model : null,
      providerRequestId: null,
      responseSeen: verified,
      observedUnits: verified ? moneyUnits('10') : null,
      verified,
      pauseProfile: false,
      reason: verified ? null : 'unknown_transport',
    });
  };
  it('keeps observed20 separate from held200, 80-percent outbox and next100 refusal', async () => {
    const store = new SqlProfileSpendStore(database());
    await finishParity(store, parityPlan('parity-one'));
    await finishParity(store, parityPlan('parity-two'));
    expect(
      (
        await pool.query(
          'SELECT sum(observed_nano) AS observed,sum(charged_nano) AS held FROM profile_spend_call',
        )
      ).rows[0],
    ).toEqual({ observed: moneyUnits('20').toString(), held: moneyUnits('200').toString() });
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM profile_spend_alert_outbox WHERE status='delivery_pending'",
        )
      ).rows[0].count,
    ).toBe('5');
    await expect(store.reserve(parityPlan('parity-three'))).rejects.toMatchObject({ status: 429 });
    expect((await pool.query('SELECT count(*) FROM profile_spend_call')).rows[0].count).toBe('2');
  });
  it.each([true, false])(
    'carries historical completed-unreconciled/unknown hold once (verified=%s)',
    async (verified) => {
      const store = new SqlProfileSpendStore(database());
      await finishParity(
        store,
        parityPlan('historical', { at: new Date('2026-08-08T12:00:00Z'), runId: 'old-run' }),
        verified,
      );
      await store.reserve(parityPlan('new-period'));
      const row = (
        await pool.query(
          "SELECT state,reconciliation,admitted_at,observed_nano FROM profile_spend_call WHERE intent_key='historical'",
        )
      ).rows[0];
      expect(row.state).toBe(verified ? 'completed' : 'uncertain');
      expect(row.reconciliation).toBe('NOT_MEASURED');
      expect(row.admitted_at.toISOString()).toBe('2026-08-08T12:00:00.000Z');
      expect(row.observed_nano).toBe(verified ? moneyUnits('10').toString() : null);
      expect(
        (await pool.query('SELECT sum(charged_nano) AS held FROM profile_spend_call')).rows[0].held,
      ).toBe(moneyUnits('200').toString());
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM profile_spend_alert_outbox WHERE status='delivery_pending'",
          )
        ).rows[0].count,
      ).toBe('4');
      await expect(store.reserve(parityPlan('another-period-call'))).rejects.toMatchObject({
        status: 429,
      });
    },
  );
  const bindingOf = (a: SpendPage['events'][number]['attempt']) => ({
    physicalId: 'prime-' + a.id,
    clientKeyId: a.clientKeyId,
    admittedAt: a.admittedAt,
    digest: a.digest,
    runId: a.runId,
    operationId: a.operationId,
    routeEpoch: a.routeEpoch,
    provider: a.provider,
    model: a.model,
    profileId: a.profileId,
    credentialRef: a.credentialRef,
    credentialVersion: a.credentialVersion,
    qualification: a.qualification,
  });
  const mirrorOf = (page: SpendPage, direct: EnvelopeHold[] = []) =>
    new PrimeExposureEnvelope(
      { ledgerId: page.ledgerId, accountId: page.accountId, ownerProfileId: page.ownerProfileId },
      direct,
      Object.fromEntries(page.events.map((e) => [e.attempt.id, bindingOf(e.attempt)])),
    );
  it('adds direct history to MC held exposure, counts mirrored copies once and preserves partial-page holds', async () => {
    const store = new SqlProfileSpendStore(database());
    await finishParity(store, parityPlan('one'));
    await finishParity(store, parityPlan('two'));
    const page = await store.readEvents('account-a', 'client-a', '0', 500);
    const first = page.events[0].attempt;
    const direct: EnvelopeHold[] = [
      {
        route: 'mc',
        state: 'completed',
        physicalId: 'prime-' + first.id,
        runId: first.runId,
        admittedAt: first.admittedAt,
        heldNano: moneyUnits('100').toString(),
        observedNano: moneyUnits('10').toString(),
        reconciliation: 'NOT_MEASURED',
      },
      {
        route: 'direct',
        state: 'settled',
        physicalId: 'legacy-direct',
        runId: 'legacy-run',
        admittedAt: first.admittedAt,
        heldNano: moneyUnits('30').toString(),
        observedNano: moneyUnits('30').toString(),
        reconciliation: 'NOT_MEASURED',
      },
    ];
    const mirror = mirrorOf(page, direct);
    const partial = await store.readEvents('account-a', 'client-a', '0', 3);
    mirror.import(partial);
    expect(() =>
      mirror.admit(1n, moneyUnits('250'), new Date('2026-10-08'), new Date('2026-10-09')),
    ).toThrow();
    const rest = await store.readEvents('account-a', 'client-a', partial.through, 500);
    mirror.import(rest);
    direct.length = 0; // The installed direct baseline is immutable.
    expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(moneyUnits('230'));
    let dispatches = 0;
    expect(() => {
      mirror.admit(
        moneyUnits('30'),
        moneyUnits('250'),
        new Date('2026-10-08'),
        new Date('2026-10-09'),
      );
      dispatches++;
    }).toThrow();
    expect(dispatches).toBe(0);
    const before = mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'));
    expect(() => mirror.import({ ...page, events: page.events.slice(1) })).toThrow();
    expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(before);
    expect(() =>
      mirror.admit(1n, moneyUnits('250'), new Date('2026-10-08'), new Date('2026-10-09')),
    ).toThrow();
    mirror.import(page); // Exact replay catches up without adding another hold.
    expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(before);
    expect(() => mirror.import({ ...page, observedAt: '2020-01-01T00:00:00Z' })).toThrow();
    expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(before);
  });
  it.each([true, false])(
    'imports original UTC usage and retains old hold once (completed=%s)',
    async (verified) => {
      const store = new SqlProfileSpendStore(database());
      await finishParity(
        store,
        parityPlan('old-import', { at: new Date('2026-08-08T12:00:00Z'), runId: 'old-run' }),
        verified,
      );
      await store.reserve(parityPlan('new-import'));
      const page = await store.readEvents('account-a', 'client-a', '0', 500);
      const mirror = mirrorOf(page);
      mirror.import(page);
      expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(
        moneyUnits('200'),
      );
      expect(page.events[3].attempt.admittedAt).toBe('2026-08-08T12:00:00.000Z');
      expect(page.events[3].attempt.observedNano).toBe(
        verified ? moneyUnits('10').toString() : null,
      );
      expect(() =>
        mirror.admit(
          moneyUnits('100'),
          moneyUnits('250'),
          new Date('2026-10-08'),
          new Date('2026-10-09'),
        ),
      ).toThrow();
      expect(() =>
        mirror.import({
          ...page,
          events: page.events.map((e, i) =>
            i === 3 ? { ...e, attempt: { ...e.attempt, heldNano: '0' } } : e,
          ),
        }),
      ).toThrow();
      expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(
        moneyUnits('200'),
      );
    },
  );
  it('preserves settled direct UTC attribution while carrying uncertain direct and unreconciled MC holds', async () => {
    const store = new SqlProfileSpendStore(database());
    await finishParity(store, parityPlan('old-mc', { at: new Date('2026-08-08T12:00:00Z') }));
    const page = await store.readEvents('account-a', 'client-a', '0', 500);
    const direct = [
      {
        physicalId: 'settled-direct',
        runId: 'old',
        route: 'direct',
        state: 'settled',
        admittedAt: '2026-08-08T12:00:00Z',
        heldNano: moneyUnits('10').toString(),
        observedNano: moneyUnits('10').toString(),
        reconciliation: 'NOT_MEASURED',
      },
      {
        physicalId: 'uncertain-direct',
        runId: 'old',
        route: 'direct',
        state: 'uncertain',
        admittedAt: '2026-08-08T12:00:00Z',
        heldNano: moneyUnits('30').toString(),
        observedNano: null,
        reconciliation: 'NOT_MEASURED',
      },
    ] as EnvelopeHold[];
    const mirror = mirrorOf(page, direct);
    mirror.import(page);
    expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(moneyUnits('130'));
    expect(() =>
      mirror.admit(
        moneyUnits('130'),
        moneyUnits('250'),
        new Date('2026-10-08'),
        new Date('2026-10-09'),
      ),
    ).toThrow();
  });
  it('refuses first-page held below reserve and later incoherent observed exposure while retaining prior holds', async () => {
    const store = new SqlProfileSpendStore(database());
    await finishParity(store, parityPlan('invalid-first'));
    const page = await store.readEvents('account-a', 'client-a', '0', 500);
    const mirror = mirrorOf(page);
    const bad = {
      ...page,
      events: page.events.map((e) => ({ ...e, attempt: { ...e.attempt, heldNano: '0' } })),
    };
    expect(() => mirror.import(bad)).toThrow();
    expect(() =>
      mirror.admit(1n, moneyUnits('250'), new Date('2026-10-08'), new Date('2026-10-09')),
    ).toThrow();
    mirror.import(page);
    const before = mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'));
    const incoherent = {
      ...page,
      events: page.events.map((e) => ({
        ...e,
        attempt: { ...e.attempt, observedNano: moneyUnits('200').toString() },
      })),
    };
    expect(() => mirrorOf(page).import(incoherent)).toThrow(); // First import validates observed-cost coherence too.
    expect(() => mirror.import(incoherent)).toThrow();
    expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(before);
    expect(() =>
      mirror.admit(1n, moneyUnits('250'), new Date('2026-10-08'), new Date('2026-10-09')),
    ).toThrow();
  });
  it('scopes events to owner, refuses ahead cursor and preserves committed sequence order', async () => {
    const store = new SqlProfileSpendStore(database());
    await finishParity(store, parityPlan('events'));
    const page = await store.readEvents('account-a', 'client-a', '0');
    expect(page.events.map((e) => e.sequence)).toEqual(['1', '2', '3', '4']);
    expect(page.through).toBe(page.watermark);
    await expect(store.readEvents('account-a', 'client-b', '0')).rejects.toMatchObject({
      status: 404,
    });
    await expect(store.readEvents('account-a', 'client-a', '5')).rejects.toMatchObject({
      status: 409,
    });
    expect(page.events[0].attempt.admissionCaps[0].authority).toBe('mc_client');
    expect(page.events[0].attempt.admissionCaps[0].scope).toBe('mc_client_currency');
    expect(JSON.stringify(page)).not.toContain('private-prompt-canary-only'); // Prompt is not exported.
  });
  const mutantMirror = (before: string, after: string): typeof PrimeExposureEnvelope => {
    const source = readFileSync(
      join(process.cwd(), 'src/billing/profile-spend/envelope-mirror.ts'),
      'utf8',
    );
    expect(source.includes(before)).toBe(true);
    const compiled = ts.transpileModule(source.replace(before, after), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    const exports: Record<string, unknown> = {};
    runInNewContext(compiled.outputText, {
      exports,
      Date,
      require: (name: string) => {
        if (name === './plan') return { ProfileSpendError };
        if (name === './envelope') return { spendPageSchema, spendQualificationSchema };
        if (name === './reliance') return { assertSpendReliance };
        throw new Error('Unexpected mutation import');
      },
    });
    return exports.PrimeExposureEnvelope as typeof PrimeExposureEnvelope;
  };
  it.each(['direct', 'carry', 'dedup', 'pause'])(
    'actual %s guard-removal mutant turns the shared oracle RED',
    async (guard) => {
      const store = new SqlProfileSpendStore(database());
      await finishParity(
        store,
        parityPlan('mutation', guard === 'carry' ? { at: new Date('2026-08-08T12:00:00Z') } : {}),
      );
      const page = await store.readEvents('account-a', 'client-a', '0', 500);
      const a = page.events[0].attempt;
      const direct: EnvelopeHold[] =
        guard === 'direct'
          ? [
              {
                route: 'direct',
                state: 'settled',
                physicalId: 'direct-history',
                runId: a.runId,
                admittedAt: a.admittedAt,
                heldNano: moneyUnits('100').toString(),
                observedNano: moneyUnits('100').toString(),
                reconciliation: 'NOT_MEASURED',
              },
            ]
          : guard === 'dedup'
            ? [
                {
                  route: 'mc',
                  state: 'completed',
                  physicalId: 'prime-' + a.id,
                  runId: a.runId,
                  admittedAt: a.admittedAt,
                  heldNano: moneyUnits('100').toString(),
                  observedNano: null,
                  reconciliation: 'NOT_MEASURED',
                },
              ]
            : [];
      const replacements: Record<string, [string, string]> = {
        direct: ['[...this.direct, ...this.mc.values()]', '[...this.mc.values()]'],
        carry: ['(at < from.getTime() && hold.carry)', 'false'],
        dedup: ['unique.set(hold.physicalId,', "unique.set(hold.physicalId + ':' + unique.size,"],
        pause: [
          "if (this.paused || Date.now() - this.observedAt > 60_000) throw new ProfileSpendError('prime_envelope_paused');",
          '',
        ],
      };
      const oracle = (Ctor: typeof PrimeExposureEnvelope) => {
        const mirror = new Ctor(
          {
            ledgerId: page.ledgerId,
            accountId: page.accountId,
            ownerProfileId: page.ownerProfileId,
          },
          direct,
          { [a.id]: bindingOf(a) },
        );
        if (guard !== 'pause') mirror.import(page);
        if (guard === 'dedup') {
          expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(
            moneyUnits('100'),
          );
        } else {
          const reserve =
            guard === 'pause' ? 1n : guard === 'direct' ? moneyUnits('100') : moneyUnits('200');
          let dispatches = 0;
          try {
            mirror.admit(
              reserve,
              moneyUnits('250'),
              new Date('2026-10-08'),
              new Date('2026-10-09'),
            );
            dispatches++;
          } catch (err) {
            expect(err).toBeInstanceOf(ProfileSpendError);
          }
          expect(dispatches).toBe(0);
        }
      };
      oracle(PrimeExposureEnvelope);
      expect(() => oracle(mutantMirror(...replacements[guard]))).toThrow();
    },
  );
  it('exports immutable F3 reliance fields and refuses mapping/snapshot substitutions before initial import', async () => {
    const store = new SqlProfileSpendStore(database());
    const p = parityPlan('qualified');
    await finishParity(store, p);
    const page = await store.readEvents('account-a', 'client-a', '0', 500);
    const first = page.events[0].attempt;
    expect(first.qualification.requestBytes).toBe(
      Buffer.byteLength(JSON.stringify(buildDeepSeekRequestBody(p.request))),
    );
    expect(first.qualification.tariff.capability.sha256).toBe('a'.repeat(64));
    expect(page.events[3].attempt.servedModel).toBe(p.model);
    expect(page.events[3].attempt.providerRequestId).toBeNull(); // Absent upstream identity stays unknown.
    const registry = { [first.id]: bindingOf(first) };
    const create = (Ctor = PrimeExposureEnvelope) =>
      new Ctor(
        { ledgerId: page.ledgerId, accountId: page.accountId, ownerProfileId: page.ownerProfileId },
        [],
        registry,
      );
    create().import(page);
    const mutations = [
      (a: typeof first) => {
        a.operationId = 'other-operation';
      },
      (a: typeof first) => {
        a.routeEpoch = 'other-epoch';
      },
      (a: typeof first) => {
        a.qualification.tariff.inputPerMTok = '1';
      },
      (a: typeof first) => {
        a.qualification.policy.revision = 'other-policy';
      },
      (a: typeof first) => {
        a.qualification.tariff.capability.sha256 = 'b'.repeat(64);
      },
      (a: typeof first) => {
        a.qualification.outputTokenCeiling = 1;
      },
      (a: typeof first) => {
        a.qualification.requestBytes = 513;
      },
      (a: typeof first) => {
        a.servedModel = 'substitute-model';
      },
      (a: typeof first) => {
        a.inputTokens = '11';
      },
      (a: typeof first) => {
        a.admissionCaps[0].limitNano = '1';
      },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(page);
      mutate(bad.events[0].attempt);
      const mirror = create();
      expect(() => mirror.import(bad)).toThrow();
      let dispatches = 0;
      expect(() => {
        mirror.admit(1n, moneyUnits('250'), new Date('2026-10-08'), new Date('2026-10-09'));
        dispatches++;
      }).toThrow();
      expect(dispatches).toBe(0);
    }
    const bad = structuredClone(page);
    bad.events[0].attempt.operationId = 'other-operation';
    const mutant = create(mutantMirror('assertSpendReliance(attempt, binding);', ''));
    expect(() => mutant.import(bad)).not.toThrow(); // Guard removal really accepts the forbidden first page.
    const mirror = create();
    mirror.import(page);
    const held = mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'));
    expect(() => mirror.import(bad)).toThrow();
    expect(mirror.exposure(new Date('2026-10-08'), new Date('2026-10-09'))).toBe(held);
  });
  it('independently checks reserve/observed arithmetic even with a matching trusted snapshot', async () => {
    const store = new SqlProfileSpendStore(database());
    await finishParity(store, parityPlan('arithmetic'));
    const page = await store.readEvents('account-a', 'client-a', '0', 500);
    const badReserve = structuredClone(page);
    badReserve.events[0].attempt.reserveNano = moneyUnits('99').toString();
    expect(() => mirrorOf(badReserve).import(badReserve)).toThrow();
    const badObserved = structuredClone(page);
    badObserved.events[3].attempt.observedNano = moneyUnits('11').toString();
    expect(() => mirrorOf(badObserved).import(badObserved)).toThrow();
    const expired = structuredClone(page);
    for (const e of expired.events)
      e.attempt.qualification.tariff.capability.validUntil = '2026-07-01T00:00:00Z';
    expect(() => mirrorOf(expired).import(expired)).toThrow();
  });
  it('serves real HTTP+PG events with native auth guard and fresh policy scope, rejects revoked/foreign keys', async () => {
    const store = new SqlProfileSpendStore(database());
    await finishParity(store, parityPlan('http'));
    const db = database();
    const prisma = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
        (await db.query(sql, values)).rows,
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        db.transaction((sql) =>
          fn({
            $queryRawUnsafe: async (text: string, ...values: unknown[]) =>
              (await sql.query(text, values)).rows,
          }),
        ),
    } as unknown as PrismaService;
    let policyOwner = 'client-a';
    const policies = {
      getPolicyForKey: async (id: string) => ({
        policyVersion: 2,
        profile: { id: id === 'key-a' ? policyOwner : 'client-b', accountingBucket: 'account-a' },
        spend: {},
      }),
    } as unknown as PolicyService;
    const events = new ProfileSpendEventsService(prisma, policies);
    const auth = {
      validateKey: async (token: string) =>
        token === 'fixture-a' ? { id: 'key-a' } : token === 'fixture-b' ? { id: 'key-b' } : null,
    } as unknown as AuthService;
    const module = await Test.createTestingModule({
      controllers: [ProfileSpendEventsController],
      providers: [
        { provide: ProfileSpendEventsService, useValue: events },
        { provide: APP_GUARD, useValue: new AuthGuard(auth, new Reflector()) },
      ],
    }).compile();
    const app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    try {
      const url = await app.getUrl();
      const get = (token: string, query = '') =>
        fetch(url + '/api/v1/profile-spend/events' + query, {
          headers: { authorization: 'Bearer ' + token },
        });
      const valid = await get('fixture-a');
      expect(valid.status).toBe(200);
      const page = await valid.json();
      expect(page.events).toHaveLength(4);
      expect(page.accountId).toBe('account-a');
      expect((await get('revoked-fixture')).status).toBe(401);
      expect((await get('fixture-b')).status).toBe(404);
      expect((await get('fixture-a', '?accountId=account-b')).status).toBe(400);
      policyOwner = 'client-b'; // No cached membership survives policy revocation.
      expect((await get('fixture-a')).status).toBe(404);
      expect((await pool.query('SELECT count(*) FROM profile_spend_event')).rows[0].count).toBe(
        '4',
      );
    } finally {
      await app.close();
    }
  });
  it('rejects a foreign client claiming an existing accounting bucket', async () => {
    const store = new SqlProfileSpendStore(database());
    await store.reserve(plan('owner'));
    await expect(
      store.reserve(plan('foreign', { ownerProfileId: 'client-b', clientKeyId: 'key-b' })),
    ).rejects.toMatchObject({
      status: 503,
      response: { error: 'profile_spend_account_binding' },
    });
    expect((await pool.query('SELECT count(*) FROM profile_spend_call')).rows[0].count).toBe('1');
  });
  it.each(['client-day', 'client-month', 'profile-day', 'profile-month', 'run'])(
    'independently enforces %s without relying on another cap',
    async (scope) => {
      const p = plan('first', { runId: 'same-run' });
      p.policy.client.dailyLimit = p.policy.client.monthlyLimit = p.policy.client.runLimit = '100';
      p.policy.providers.deepseek.dailyLimit = p.policy.providers.deepseek.monthlyLimit = '100';
      if (scope === 'client-day') p.policy.client.dailyLimit = '1';
      if (scope === 'client-month') p.policy.client.monthlyLimit = '1';
      if (scope === 'profile-day') p.policy.providers.deepseek.dailyLimit = '1';
      if (scope === 'profile-month') p.policy.providers.deepseek.monthlyLimit = '1';
      if (scope === 'run') p.policy.client.runLimit = '1';
      const store = new SqlProfileSpendStore(database());
      await store.reserve(p);
      await expect(
        store.reserve({ ...p, intentKey: 'second', digest: 'second' }),
      ).rejects.toMatchObject({ status: 429 });
      expect((await pool.query('SELECT count(*) FROM profile_spend_call')).rows[0].count).toBe('1');
    },
  );
  it('never sums reservation and observed cost, retains the greater exposure', async () => {
    const p = plan('observed');
    const store = new SqlProfileSpendStore(database());
    const id = await store.reserve(p);
    await store.claim(id);
    await store.markEgress(id);
    await store.finish(id, p, {
      inputTokens: 1,
      outputTokens: 1,
      servedModel: p.model,
      providerRequestId: 'opaque-observation',
      responseSeen: true,
      observedUnits: moneyUnits('0.2'),
      verified: true,
      pauseProfile: false,
      reason: null,
    });
    expect(
      (await pool.query('SELECT charged_nano,observed_nano FROM profile_spend_call')).rows[0],
    ).toEqual({ charged_nano: '600000000', observed_nano: '200000000' });
  });
  it('rejects settlement against another client identity without modifying its call', async () => {
    const p = plan('owned');
    const store = new SqlProfileSpendStore(database());
    const id = await store.reserve(p);
    await store.claim(id);
    await store.markEgress(id);
    await expect(
      store.finish(
        id,
        { ...p, clientKeyId: 'key-b' },
        {
          inputTokens: 1,
          outputTokens: 1,
          servedModel: p.model,
          providerRequestId: null,
          responseSeen: true,
          observedUnits: 0n,
          verified: true,
          pauseProfile: false,
          reason: null,
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect((await pool.query('SELECT state FROM profile_spend_call')).rows[0].state).toBe(
      'dispatch_started',
    );
  });
});
