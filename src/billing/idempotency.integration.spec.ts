/**
 * ARAS-0058 — per-INTENT idempotency, end to end, against a real Postgres.
 *
 * The finding: the ledger key was `request:${created.id}`, where `created.id`
 * was a fresh uuid minted by `prisma.request.create` INSIDE the logging path.
 * The docstring claimed a retry settles once; that held only for a retry of
 * `settle()`, which nothing performs. What production actually does is time out
 * and re-POST, and against a per-attempt key that is a second provider call and
 * a second charge.
 *
 * So the assertion is deliberately not "settle is idempotent". It is the thing
 * the customer experiences: ONE provider call and ONE ledger row across a
 * replay. That requires the whole path — controller header, gate, dispatch,
 * transactional settle — so this drives the real ConnectorsService against the
 * real database with only the provider itself faked.
 */

import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { PrismaService } from '../prisma/prisma.service';
import { validateEnv } from '../config/env.schema';

const prisma = new PrismaService();
const billing = new BillingService(prisma);

const KEY_ID = '33333333-3333-4333-8333-333333333333';

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_TIMEOUT_MS: '300000',
  CONNECTOR_MAX_CONCURRENCY: '1',
  STT_GROQ_API_KEY: 'test-groq-key',
};

/** A provider that answers instantly and counts how often it was asked. */
function fakeConnector() {
  return {
    name: 'groq',
    type: 'api',
    execute: vi.fn(async () => ({
      id: 'r1',
      connector: 'groq',
      model: 'llama',
      result: 'the one true answer',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.05 },
      latencyMs: 5,
      status: 'success' as const,
    })),
    getStatus: vi.fn().mockReturnValue({ rateLimitStatus: 'ok' }),
    getCapabilities: vi.fn().mockReturnValue({
      name: 'groq',
      type: 'api',
      models: ['llama'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    }),
  };
}

function buildService(enforced: boolean) {
  validateEnv({ ...BASE_ENV, BILLING_ENFORCED: enforced ? 'true' : 'false' });
  const connector = fakeConnector();
  const service = new ConnectorsService(
    { add: vi.fn() } as never,
    prisma,
    { record: vi.fn(), recordFailover: vi.fn() } as never,
    { process: vi.fn(async (r: unknown) => r) } as never,
    undefined,
    {
      findAll: async () => [
        { connector: 'groq', model: 'llama', inputPerMTok: 5, outputPerMTok: 5 },
      ],
    } as never,
    null,
    undefined,
    undefined,
    billing,
  );
  service.register(connector as never);
  return { service, connector };
}

async function resetAccount(): Promise<void> {
  await prisma.request.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.requestIntent.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsLedger.deleteMany({ where: { apiKeyId: KEY_ID } });
  await prisma.creditsBalance.deleteMany({ where: { apiKeyId: KEY_ID } });
}

async function fund(amountUsd: string): Promise<void> {
  await billing.credit({
    apiKeyId: KEY_ID,
    amountUsd,
    idempotencyKey: `fund-${KEY_ID}-${Math.random()}`,
    reason: 'test funding',
  });
}

function ledgerSum(entries: { amountUsd: Prisma.Decimal }[]): string {
  return entries
    .reduce((acc, e) => acc.plus(new Prisma.Decimal(e.amountUsd)), new Prisma.Decimal(0))
    .toString();
}

beforeAll(async () => {
  await prisma.apiKey.upsert({
    where: { id: KEY_ID },
    create: { id: KEY_ID, name: 'aras-0058-idem-test', keyHash: `hash-${KEY_ID}` },
    update: {},
  });
});

beforeEach(resetAccount);

afterAll(async () => {
  await resetAccount();
  await prisma.apiKey.deleteMany({ where: { id: KEY_ID } });
  await prisma.$disconnect();
});

describe('idempotency, per intent rather than per attempt', () => {
  it('a replay makes one provider call and one ledger row', async () => {
    await fund('10');
    const { service, connector } = buildService(true);
    const request = { prompt: 'hello', model: 'llama', idempotencyKey: 'client-key-alpha' };

    const first = await service.execute('groq', { ...request }, KEY_ID);
    const second = await service.execute('groq', { ...request }, KEY_ID);

    expect(first.status).toBe('success');
    // The caller gets the same answer, not a second one.
    expect(second.result).toBe(first.result);

    expect(connector.execute).toHaveBeenCalledTimes(1);

    const charges = await prisma.creditsLedger.findMany({
      where: { apiKeyId: KEY_ID, entryType: 'charge' },
    });
    expect(charges).toHaveLength(1);
    expect(new Prisma.Decimal(charges[0].amountUsd).toString()).toBe('-0.05');

    // And exactly one Request row: a replay is not a new request.
    const requests = await prisma.request.findMany({ where: { apiKeyId: KEY_ID } });
    expect(requests).toHaveLength(1);

    expect((await billing.balance(KEY_ID)).toString()).toBe('9.95');
  });

  it('charges twice WITHOUT a key, which is why the header exists', async () => {
    // The pre-ARAS-0058 behaviour, pinned deliberately. Two identical POSTs
    // with no Idempotency-Key are two intents, because the server has no way to
    // know the caller meant one. This is not a bug being tolerated — it is the
    // reason the header is the fix, and it must keep working that way so the
    // contract is legible: no key, no promise.
    await fund('10');
    const { service, connector } = buildService(true);
    const request = { prompt: 'hello', model: 'llama' };

    await service.execute('groq', { ...request }, KEY_ID);
    await service.execute('groq', { ...request }, KEY_ID);

    expect(connector.execute).toHaveBeenCalledTimes(2);
    const charges = await prisma.creditsLedger.findMany({
      where: { apiKeyId: KEY_ID, entryType: 'charge' },
    });
    expect(charges).toHaveLength(2);
    expect((await billing.balance(KEY_ID)).toString()).toBe('9.9');
  });

  it('refuses a key reused for a different payload rather than replaying', async () => {
    await fund('10');
    const { service, connector } = buildService(true);

    await service.execute(
      'groq',
      { prompt: 'the first question', model: 'llama', idempotencyKey: 'client-key-beta' },
      KEY_ID,
    );
    const second = await service.execute(
      'groq',
      {
        prompt: 'a COMPLETELY different question',
        model: 'llama',
        idempotencyKey: 'client-key-beta',
      },
      KEY_ID,
    );

    expect(second.status).toBe('error');
    expect(second.error?.type).toBe('idempotency_key_reused');
    expect(connector.execute).toHaveBeenCalledTimes(1);
  });

  it('scopes keys per api key, so one caller cannot read another one back', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    await prisma.apiKey.upsert({
      where: { id: OTHER },
      create: { id: OTHER, name: 'aras-0058-idem-other', keyHash: `hash-${OTHER}` },
      update: {},
    });
    try {
      await fund('10');
      await billing.credit({
        apiKeyId: OTHER,
        amountUsd: '10',
        idempotencyKey: `fund-other-${Math.random()}`,
      });
      const { service, connector } = buildService(true);
      const request = { prompt: 'hello', model: 'llama', idempotencyKey: 'a-popular-key' };

      await service.execute('groq', { ...request }, KEY_ID);
      const other = await service.execute('groq', { ...request }, OTHER);

      // Same key string, different account: a real dispatch, not a replay of
      // somebody else's response.
      expect(other.status).toBe('success');
      expect(connector.execute).toHaveBeenCalledTimes(2);
    } finally {
      await prisma.requestIntent.deleteMany({ where: { apiKeyId: OTHER } });
      await prisma.request.deleteMany({ where: { apiKeyId: OTHER } });
      await prisma.creditsLedger.deleteMany({ where: { apiKeyId: OTHER } });
      await prisma.creditsBalance.deleteMany({ where: { apiKeyId: OTHER } });
      await prisma.apiKey.deleteMany({ where: { id: OTHER } });
    }
  });

  it('lets a caller retry the same key after the first attempt FAILED', async () => {
    // The trap this avoids: a released intent that stays claimed would block
    // the caller for the whole retention window BECAUSE they asked for
    // idempotency — and the request they wanted was never performed or charged.
    // A failed attempt has to leave the key usable.
    await fund('10');
    const { service, connector } = buildService(true);
    const request = { prompt: 'hello', model: 'llama', idempotencyKey: 'client-key-retry' };

    connector.execute.mockRejectedValueOnce(new Error('provider exploded'));
    await expect(service.execute('groq', { ...request }, KEY_ID)).rejects.toThrow(
      'provider exploded',
    );

    // The reservation went back, and nothing was charged.
    expect((await billing.available(KEY_ID)).toString()).toBe('10');
    expect(
      await prisma.creditsLedger.count({ where: { apiKeyId: KEY_ID, entryType: 'charge' } }),
    ).toBe(0);

    const retry = await service.execute('groq', { ...request }, KEY_ID);
    expect(retry.status).toBe('success');
    expect(connector.execute).toHaveBeenCalledTimes(2);

    // And the retry is now the intent's stored answer, so a THIRD call replays
    // it rather than dispatching again.
    const third = await service.execute('groq', { ...request }, KEY_ID);
    expect(third.result).toBe(retry.result);
    expect(connector.execute).toHaveBeenCalledTimes(2);
    expect(
      await prisma.creditsLedger.count({ where: { apiKeyId: KEY_ID, entryType: 'charge' } }),
    ).toBe(1);
  });

  it('still refuses a reclaimed key used with a different payload', async () => {
    // Reclaiming an abandoned key must not become a way to launder a key reuse:
    // the fingerprint is checked before the state.
    await fund('10');
    const { service, connector } = buildService(true);

    connector.execute.mockRejectedValueOnce(new Error('provider exploded'));
    await expect(
      service.execute(
        'groq',
        { prompt: 'the first question', model: 'llama', idempotencyKey: 'client-key-delta' },
        KEY_ID,
      ),
    ).rejects.toThrow('provider exploded');

    const second = await service.execute(
      'groq',
      { prompt: 'a different question', model: 'llama', idempotencyKey: 'client-key-delta' },
      KEY_ID,
    );
    expect(second.error?.type).toBe('idempotency_key_reused');
  });

  it('settles the request row and the charge in the SAME transaction', async () => {
    // ARAS-0058's durability fix. Settlement used to live in a
    // fire-and-forget `logRequest(...).catch(...)`, so the response reached the
    // customer before either row existed. Now the Request row and the ledger
    // row commit together — which is what makes "no Request row without a
    // charge" an invariant rather than a hope.
    await fund('10');
    const { service } = buildService(true);

    await service.execute(
      'groq',
      { prompt: 'hello', model: 'llama', idempotencyKey: 'client-key-gamma' },
      KEY_ID,
    );

    const requests = await prisma.request.findMany({ where: { apiKeyId: KEY_ID } });
    expect(requests).toHaveLength(1);
    const charge = await prisma.creditsLedger.findFirst({
      where: { apiKeyId: KEY_ID, entryType: 'charge' },
    });
    expect(charge?.requestId).toBe(requests[0].id);
  });

  it('releases the reservation and leaves the ledger clean when the request is refused', async () => {
    // A one-cent balance against a request estimated well above it.
    await fund('0.01');
    const { service, connector } = buildService(true);

    const response = await service.execute(
      'groq',
      { prompt: 'x'.repeat(4_000), model: 'llama', extra: { max_tokens: 64_000 } },
      KEY_ID,
    );

    expect(response.error?.type).toBe('credit_depleted');
    expect(connector.execute).not.toHaveBeenCalled();
    expect((await billing.available(KEY_ID)).toString()).toBe('0.01');
    const entries = await prisma.creditsLedger.findMany({ where: { apiKeyId: KEY_ID } });
    expect(ledgerSum(entries)).toBe('0.01');
  });

  it('records spend but reserves nothing while enforcement is off', async () => {
    // The dark-ship posture, proved against the real ledger rather than a mock.
    const { service, connector } = buildService(false);

    const response = await service.execute('groq', { prompt: 'hello', model: 'llama' }, KEY_ID);

    expect(response.status).toBe('success');
    expect(connector.execute).toHaveBeenCalledTimes(1);
    const entries = await prisma.creditsLedger.findMany({ where: { apiKeyId: KEY_ID } });
    // An uncredited account still gets the charge on the ledger — and the
    // matching write-off, because the database floor forbids a negative
    // balance. Together they sum to zero, which is the truth: 0.05 USD of
    // measured spend that nobody had the credit to cover.
    expect(entries.map((e) => e.entryType).sort()).toEqual(['charge', 'uncollectible']);
    expect(ledgerSum(entries)).toBe('0');
    expect((await billing.balance(KEY_ID)).toString()).toBe('0');
  });
});
