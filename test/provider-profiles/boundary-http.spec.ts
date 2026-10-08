import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { Logger, ConsoleLogger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { hash } from 'bcryptjs';
import { STRICT_CHAT_BOUNDARY, StrictChatService } from '../../src/connectors/strict-chat/service';
import { ConnectorsController } from '../../src/connectors/connectors.controller';
import { ConnectorsService } from '../../src/connectors/connectors.service';
import { JevConnector } from '../../src/connectors/jev/jev.connector';
import { AzureOpenAiConnector } from '../../src/connectors/azure-openai/azure-openai.connector';
import { PerplexityConnector } from '../../src/connectors/perplexity/perplexity.connector';
import { DeepSeekConnector } from '../../src/connectors/deepseek/deepseek.connector';
import { request as decision, nativeResponse } from '../../src/connectors/jev/decision.fixture';
import { ImageGenerationService } from '../../src/connectors/image-generation/image-generation.service';
import { CascadeRouterService } from '../../src/connectors/cascade/cascade-router.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AdminService } from '../../src/admin/admin.service';
import { AdminController } from '../../src/admin/admin.controller';
import { AdminGuard } from '../../src/admin/admin.guard';
import { AuthService } from '../../src/auth/auth.service';
import { AuthGuard } from '../../src/auth/auth.guard';
import { RateLimitGuard } from '../../src/auth/rate-limit.guard';
import { KeyRateLimitService } from '../../src/auth/key-rate-limit.service';
import { validateEnv } from '../../src/config/env.schema';
import { apiKeyPolicySchema, ApiKeyPolicy } from '../../src/policy/policy.schema';
import { PolicyService } from '../../src/policy/policy.service';
import { providerKeyContext } from '../../src/policy/provider-key.context';
import { resolveRegisteredCredential } from '../../src/policy/credential-registry';

function fixtureCredential(provider: string, id: string): string {
  return `synthetic-${provider}-${id}-1`;
}

function profile(id: string, provider: string): ApiKeyPolicy {
  return apiKeyPolicySchema.parse({
    policyVersion: 2,
    profile: { id, revision: '1', accountingBucket: id },
    providers: [provider],
    models: { mode: 'list', list: [provider === 'deepseek' ? 'deepseek-v4-flash' : 'jev-latest'] },
    providerKeys: { [provider]: [{ credentialRef: `${id}-${provider}`, version: '1' }] },
  });
}

function registry() {
  return Object.fromEntries(
    ['a', 'b'].flatMap((id) =>
      ['deepseek', 'typesafe-jev'].map((provider) => [
        `${id}-${provider}`,
        {
          provider,
          profileId: id,
          clientKeyIds: [`key-${id}`],
          versions: {
            '1': `${provider === 'deepseek' ? 'DEEPSEEK' : 'TYPESAFE'}_API_KEY_${id.toUpperCase()}_1`,
          },
        },
      ]),
    ),
  );
}

/** Only PG/Redis and terminal upstream HTTP are doubled; real auth, guards, route and adapters. */
class CounterRedis {
  private counts = new Map<string, number>();
  multi() {
    const ops: Array<() => [null, unknown]> = [];
    const chain = {
      incr: (key: string) => {
        ops.push(() => {
          const value = (this.counts.get(key) ?? 0) + 1;
          this.counts.set(key, value);
          return [null, value];
        });
        return chain;
      },
      expire: () => {
        ops.push(() => [null, 1]);
        return chain;
      },
      get: (key: string) => {
        ops.push(() => [null, this.counts.has(key) ? String(this.counts.get(key)) : null]);
        return chain;
      },
      exec: async () => ops.map((op) => op()),
    };
    return chain;
  }
  async incr(key: string) {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }
  async expire() {
    return 1;
  }
}

describe('dedicated provider profiles through real MC HTTP and adapters', () => {
  let app: NestFastifyApplication;
  let service: ConnectorsService;
  let rows: Record<
    string,
    {
      id: string;
      name: string;
      keyHash: string;
      active: boolean;
      rateLimit: number;
      policy: ApiKeyPolicy | null;
    }
  >;
  let records: Array<Record<string, unknown>>;
  let capturedLogs: unknown[][];
  const sent: Array<{ url: string; authorization: string; client?: string }> = [];
  const fetchMock = vi.fn();
  const strictExecute =
    vi.fn<(...args: Parameters<StrictChatService['execute']>) => Promise<void>>();
  let prisma: PrismaService;
  beforeEach(async () => {
    capturedLogs = [];
    strictExecute.mockReset();
    strictExecute.mockImplementation(async (_name, _tenant, _body, sink, signal) => {
      await sink('data: {"fixture":true}\n\n', signal);
    });
    const capture = (...messages: unknown[]) => {
      capturedLogs.push(messages);
    };
    Logger.overrideLogger({
      log: capture,
      error: capture,
      warn: capture,
      debug: capture,
      verbose: capture,
      fatal: capture,
    });
    for (const provider of ['TYPESAFE', 'DEEPSEEK']) {
      vi.stubEnv(`${provider}_API_KEY`, `shared-${provider}`);
      for (const id of ['A', 'B'])
        vi.stubEnv(`${provider}_API_KEY_${id}_1`, fixtureCredential(provider, id));
    }
    vi.stubEnv('JEV_ENABLED', 'true');
    vi.stubEnv('ADMIN_TOKEN', 'fixture-admin');
    vi.stubEnv('PROVIDER_CREDENTIAL_REGISTRY', JSON.stringify(registry()));
    validateEnv({
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
      STT_GROQ_API_KEY: 'fixture',
      CONNECTOR_MAX_CONCURRENCY: '4',
    });
    rows = Object.fromEntries(
      await Promise.all(
        ['a', 'b'].map(async (id) => [
          `key-${id}`,
          {
            id: `key-${id}`,
            name: id,
            keyHash: await hash(`client-${id}`, 4),
            active: true,
            rateLimit: 100,
            policy: null,
          },
        ]),
      ),
    );
    records = [];
    sent.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const outgoing = JSON.parse(String(init.body));
      sent.push({
        url,
        authorization: (init.headers as Record<string, string>).Authorization,
        client: url.includes('typesafe') ? outgoing.state : outgoing.messages.at(-1).content,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      const body = url.includes('typesafe')
        ? {
            ...nativeResponse,
            answers: {
              ...nativeResponse.answers,
              tier: { ...nativeResponse.answers.tier, confidence: 0.6 },
            },
            usage: { input_tokens: 12, output_tokens: 8 },
          }
        : {
            model: 'deepseek-v4-flash',
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const db: Record<string, unknown> = {
      apiKey: {
        findMany: async () => Object.values(rows).filter((row) => row.active),
        findUnique: async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const row = rows[where.id];
          return row
            ? select
              ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k as keyof typeof row]]))
              : row
            : null;
        },
        update: async ({ where, data }: { where: { id: string }; data: object }) =>
          Object.assign(rows[where.id], data),
      },
      request: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          records.push(data);
          return { id: String(records.length) };
        },
      },
      modelCatalog: { findUnique: async () => null },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    };
    prisma = db as unknown as PrismaService;
    service = new ConnectorsService(
      {} as never,
      prisma,
      { record() {} } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      new PolicyService(prisma),
    );
    service.register(new JevConnector());
    service.register(new DeepSeekConnector());
    const auth = new AuthService(prisma);
    const limiter = new KeyRateLimitService(new CounterRedis(), prisma);
    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectorsController, AdminController],
      providers: [
        AdminGuard,
        { provide: STRICT_CHAT_BOUNDARY, useValue: { execute: strictExecute } },
        { provide: AdminService, useValue: new AdminService(prisma) },
        { provide: ConnectorsService, useValue: service },
        { provide: ImageGenerationService, useValue: {} },
        { provide: CascadeRouterService, useValue: {} },
        { provide: AuthService, useValue: auth },
        { provide: KeyRateLimitService, useValue: limiter },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => {
    await app?.close();
    Logger.overrideLogger(new ConsoleLogger());
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const payload = (provider: string) => ({
    prompt: provider === 'typesafe-jev' ? JSON.stringify(decision) : 'hello',
    model: provider === 'typesafe-jev' ? 'jev-latest' : 'deepseek-v4-flash',
    maxRetries: 0,
  });
  const call = (id: string, provider: string) =>
    app.inject({
      method: 'POST',
      url: `/connectors/${provider}/execute`,
      headers: { authorization: `Bearer client-${id}` },
      payload: {
        ...payload(provider),
        prompt:
          provider === 'typesafe-jev'
            ? JSON.stringify({ ...decision, state: `client-${id}` })
            : `client-${id}`,
      },
    });

  it.each(['typesafe-jev', 'deepseek'])(
    'keeps concurrent A/B %s credentials isolated and persists actual nonsensitive identity',
    async (provider) => {
      rows['key-a'].policy = profile('a', provider);
      rows['key-b'].policy = profile('b', provider);
      const replies = await Promise.all([
        call('a', provider),
        call('b', provider),
        call('a', provider),
        call('b', provider),
      ]);
      expect(replies.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
      const prefix = provider === 'typesafe-jev' ? 'TYPESAFE' : 'DEEPSEEK';
      expect(sent).toHaveLength(4);
      for (const send of sent) {
        expect(send.authorization).toBe(
          `Bearer synthetic-${prefix}-${send.client!.slice(-1).toUpperCase()}-1`,
        );
      }
      expect(records).toHaveLength(4);
      for (const row of records)
        expect(row).toMatchObject({
          upstreamCredentialRef: `${String(row.apiKeyId).slice(-1)}-${provider}`,
          upstreamCredentialVersion: '1',
          providerProfileRevision: '1',
          accountingBucket: String(row.apiKeyId).slice(-1),
        });
      for (const secret of ['A', 'B'].map((id) => `synthetic-${prefix}-${id}-1`))
        expect(JSON.stringify([records, replies.map((r) => r.json())])).not.toContain(secret);
      expect(providerKeyContext.getStore()).toBeUndefined();
    },
  );

  it('preserves legacy JEV shared-key behavior for a client without a profile', async () => {
    expect((await call('a', 'typesafe-jev')).statusCode).toBe(201);
    expect(sent.map((s) => s.authorization)).toEqual(['Bearer shared-TYPESAFE']);
    expect(records[0].upstreamCredentialRef).toBeUndefined();
  });
  it('allows dedicated-only JEV with no shared environment credential', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    rows['key-a'].policy = profile('a', 'typesafe-jev');
    expect((await call('a', 'typesafe-jev')).statusCode).toBe(201);
    expect(sent[0].authorization).toBe('Bearer synthetic-TYPESAFE-A-1');
  });
  it('refuses a missing Prime credential with zero shared fallback calls', async () => {
    rows['key-a'].policy = profile('a', 'typesafe-jev');
    vi.stubEnv('TYPESAFE_API_KEY_A_1', '');
    expect((await call('a', 'typesafe-jev')).statusCode).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
    expect(records).toEqual([]);
  });
  it('never falls back to shared after upstream rejects dedicated JEV', async () => {
    rows['key-a'].policy = profile('a', 'typesafe-jev');
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      sent.push({ url, authorization: (init.headers as Record<string, string>).Authorization });
      return new Response('denied', { status: 401 });
    });
    expect((await call('a', 'typesafe-jev')).statusCode).toBeGreaterThanOrEqual(400);
    expect(sent.map((s) => s.authorization)).toEqual(['Bearer synthetic-TYPESAFE-A-1']);
    expect(records[0]).toMatchObject({ upstreamCredentialRef: 'a-typesafe-jev', status: 'error' });
  });
  it('refuses A using B reference even when A forged the stored profile id', async () => {
    rows['key-a'].policy = profile('b', 'deepseek');
    expect((await call('a', 'deepseek')).statusCode).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
  });
  it('warm auth-cache key revoked from a different process returns 401 and sends nothing', async () => {
    rows['key-a'].policy = profile('a', 'deepseek');
    expect((await call('a', 'deepseek')).statusCode).toBe(201);
    const revoked = await app.inject({
      method: 'DELETE',
      url: '/admin/keys/key-a',
      headers: { 'x-admin-token': 'fixture-admin' },
    });
    expect(revoked.statusCode).toBe(204);
    sent.length = 0;
    expect((await call('a', 'deepseek')).statusCode).toBe(401);
    expect(sent).toEqual([]);
  });
  it('request cap gives HTTP429 and Retry-After with zero upstream call', async () => {
    rows['key-a'].policy = profile('a', 'deepseek');
    rows['key-a'].rateLimit = 1;
    expect((await call('a', 'deepseek')).statusCode).toBe(201);
    sent.length = 0;
    const refused = await call('a', 'deepseek');
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(sent).toEqual([]);
    expect(records).toHaveLength(1);
    expect((await call('b', 'deepseek')).statusCode).toBe(201);
  });
  it('redacts dedicated secret from upstream DeepSeek errors before DB and response', async () => {
    rows['key-a'].policy = profile('a', 'deepseek');
    const secret = fixtureCredential('DEEPSEEK', 'A');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: `bad ${secret}` } }), { status: 400 }),
    );
    const response = await call('a', 'deepseek');
    expect(response.json().status).toBe('error');
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(capturedLogs)).not.toContain(secret);
    expect(response.body).not.toContain(secret);
  });
  it('reads cross-replica assignment from warmed legacy policy and refuses missing dedicated key', async () => {
    expect((await call('a', 'typesafe-jev')).statusCode).toBe(201);
    rows['key-a'].policy = profile('a', 'typesafe-jev');
    vi.stubEnv('TYPESAFE_API_KEY_A_1', '');
    sent.length = 0;
    expect((await call('a', 'typesafe-jev')).statusCode).toBeGreaterThanOrEqual(400);
    expect(sent).toEqual([]);
  });
  it('reads policy over machine admin token and rejects a client key as administrator', async () => {
    rows['key-a'].policy = profile('a', 'deepseek');
    const read = await app.inject({
      method: 'GET',
      url: '/admin/keys/key-a/policy',
      headers: { 'x-admin-token': 'fixture-admin' },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ id: 'key-a', policy: rows['key-a'].policy });
    const refused = await app.inject({
      method: 'PATCH',
      url: '/admin/keys/key-a/policy',
      headers: { authorization: 'Bearer client-a' },
      payload: { policy: null },
    });
    expect(refused.statusCode).toBe(403);
    expect(rows['key-a'].policy?.policyVersion).toBe(2);
  });
  it('redacts a successful dedicated upstream secret echo before response and persistence', async () => {
    rows['key-a'].policy = profile('a', 'deepseek');
    const secret = fixtureCredential('DEEPSEEK', 'A');
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'deepseek-v4-flash',
          choices: [{ message: { content: secret } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      ),
    );
    const response = await call('a', 'deepseek');
    expect(response.statusCode).toBe(201);
    expect(response.json().result).toBe('[REDACTED]');
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(capturedLogs)).not.toContain(secret);
  });
  it.each(Array.from({ length: 41 }, (_, i) => 480 + i))(
    'redacts dedicated credentials before the 500-character cut at offset %i',
    async (offset) => {
      rows['key-a'].policy = profile('a', 'deepseek');
      const secret = fixtureCredential('DEEPSEEK', 'A');
      const padding = 'x'.repeat(offset);
      fetchMock.mockResolvedValue(new Response(padding + secret + ' suffix', { status: 401 }));
      const response = await call('a', 'deepseek');
      const expected = (padding + '[REDACTED]' + ' suffix').slice(0, 500);
      expect(response.json().error.message).toBe(expected);
      expect(records).toHaveLength(1);
      expect(records[0].errorMessage).toBe(expected);
      for (const surface of [
        response.body,
        JSON.stringify(records),
        JSON.stringify(capturedLogs),
      ]) {
        expect(surface).not.toContain(secret);
        expect(surface).not.toContain(secret.slice(0, 20));
      }
    },
  );
  it('redacts complete bodies in provider-specific error renderers and parsers', () => {
    const secret = fixtureCredential('DEEPSEEK', 'A');
    providerKeyContext.run({ provider: 'deepseek', apiKey: secret }, () => {
      const azure = new AzureOpenAiConnector() as unknown as {
        formatHttpErrorMessage(status: number, body: string): string;
      };
      const perplexity = new PerplexityConnector() as unknown as {
        parseHttpError(
          status: number,
          body: string,
          headers: Headers,
        ): { message: string; details?: unknown };
      };
      for (let offset = 480; offset <= 520; offset++) {
        const plain = 'x'.repeat(offset) + secret;
        const expected = ('x'.repeat(offset) + '[REDACTED]').slice(0, 500);
        expect(azure.formatHttpErrorMessage(401, plain)).toBe(expected);
        expect(
          azure.formatHttpErrorMessage(
            401,
            JSON.stringify({ error: { code: secret, message: plain } }),
          ),
        ).toBe('[REDACTED]: ' + 'x'.repeat(offset) + '[REDACTED]');
        for (const status of [401, 403, 422, 429, 500])
          expect(perplexity.parseHttpError(status, plain, new Headers()).message).toBe(expected);
        expect(
          perplexity.parseHttpError(422, JSON.stringify({ detail: secret }), new Headers()).details,
        ).toBe('[REDACTED]');
      }
    });
  });
  it('dispatches a legacy client through the injected strict boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/connectors/deepseek/chat/completions',
      headers: { authorization: 'Bearer client-a' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('data: {"fixture":true}\n\n');
    expect(strictExecute).toHaveBeenCalledExactlyOnceWith(
      'deepseek',
      'key-a',
      {},
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });
  it('refuses a dedicated profile on an unqualified strict route before any send', async () => {
    rows['key-a'].policy = profile('a', 'deepseek');
    const response = await app.inject({
      method: 'POST',
      url: '/connectors/deepseek/chat/completions',
      headers: { authorization: 'Bearer client-a' },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'strict_profile_unavailable' });
    expect(strictExecute).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(records).toEqual([]);
  });
  it('model allowlist refuses before fetch', async () => {
    rows['key-a'].policy = profile('a', 'deepseek');
    const response = await app.inject({
      method: 'POST',
      url: '/connectors/deepseek/execute',
      headers: { authorization: 'Bearer client-a' },
      payload: { ...payload('deepseek'), model: 'forbidden-model' },
    });
    expect(response.statusCode).toBe(403);
    expect(sent).toEqual([]);
  });
  it('rejects provider mismatch and unrelated environment-secret aliases', () => {
    const reg = registry();
    reg['a-deepseek'].provider = 'typesafe-jev';
    const env = {
      PROVIDER_CREDENTIAL_REGISTRY: JSON.stringify(reg),
      DEEPSEEK_API_KEY_A_1: 'fixture',
    };
    expect(() =>
      resolveRegisteredCredential(profile('a', 'deepseek'), 'deepseek', 'key-a', env),
    ).toThrow('unavailable');
    reg['a-deepseek'].provider = 'deepseek';
    reg['a-deepseek'].versions['1'] = 'ADMIN_TOKEN';
    expect(() =>
      resolveRegisteredCredential(profile('a', 'deepseek'), 'deepseek', 'key-a', {
        PROVIDER_CREDENTIAL_REGISTRY: JSON.stringify(reg),
        ADMIN_TOKEN: 'fixture',
      }),
    ).toThrow('unavailable');
  });
  it('pins the first declared version without switching to the next when unavailable', () => {
    const p = profile('a', 'deepseek');
    const bindings = p.providerKeys!.deepseek;
    if (typeof bindings === 'string') throw new Error('fixture');
    bindings.push({ credentialRef: 'b-deepseek', version: '1' });
    expect(() =>
      resolveRegisteredCredential(p, 'deepseek', 'key-a', {
        PROVIDER_CREDENTIAL_REGISTRY: JSON.stringify(registry()),
        DEEPSEEK_API_KEY_B_1: 'foreign',
      }),
    ).toThrow('unavailable');
  });
});
