import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { hash } from 'bcryptjs';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuthService } from '../auth/auth.service';
import { AuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../prisma/prisma.service';

vi.mock('../config/env.schema', () => ({ getConfig: () => ({ API_KEY_SALT_ROUNDS: 4 }) }));

// Actual controllers, guards, hashing and auth cache; storage is an explicit fixture.
// These tests prove HTTP/auth behavior and the write contract, not a deployed DB.
const adminToken = 'fixture-admin-token';
const oldSecret = 'fixture-old-credential';
const account = { balance: '12.34', held: '0', ledger: ['credit-receipt', 'usage-receipt'] };
let row: { id: string; name: string; active: boolean; keyHash: string; rateLimit: number };
let loseRace = false;
const updateMany = vi.fn(async ({ where, data }) => {
  if (
    loseRace ||
    where.id !== row.id ||
    where.active !== row.active ||
    where.keyHash !== row.keyHash
  ) {
    return { count: 0 };
  }
  Object.assign(row, data);
  return { count: 1 };
});
const storage = {
  apiKey: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === row.id ? { ...row } : null,
    findMany: async () => (row.active ? [{ ...row }] : []),
    updateMany,
  },
};

let app: NestFastifyApplication;
const originalAdminToken = process.env.ADMIN_TOKEN;
const body = {
  actor: 'fixture-agent',
  reason: 'Rotate credential without changing account',
  expectedActive: true,
};

beforeEach(async () => {
  process.env.ADMIN_TOKEN = adminToken;
  loseRace = false;
  updateMany.mockClear();
  row = {
    id: 'existing-account',
    name: 'fixture-principal',
    active: true,
    keyHash: await hash(oldSecret, 4),
    rateLimit: 17,
  };
  const module = await Test.createTestingModule({
    controllers: [AdminController],
    providers: [
      AdminService,
      AuthService,
      { provide: PrismaService, useValue: storage },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  }).compile();
  app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
  if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = originalAdminToken;
});

const rotate = (payload: unknown = body, token = adminToken) =>
  app.inject({
    method: 'POST',
    url: '/admin/keys/existing-account/rotate',
    headers: { 'x-admin-token': token, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
const authenticate = (secret: string) => app.get(AuthService).validateKey(secret);

describe('account-preserving key rotation', () => {
  it('retains the funded identity and ledger; cached old credential fails immediately', async () => {
    expect(await authenticate(oldSecret)).toMatchObject({ id: row.id }); // Populate the real cache.
    const before = structuredClone(account);
    const response = await rotate();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const replacement = response.json();
    expect(replacement).toMatchObject({
      id: 'existing-account',
      name: 'fixture-principal',
      active: true,
    });
    expect(replacement.key).toMatch(/^mc-[a-f0-9]{32}$/);
    expect(row.rateLimit).toBe(17);
    expect(account).toEqual(before);
    expect(await authenticate(oldSecret)).toBeNull();
    expect(await authenticate(replacement.key)).toMatchObject({ id: 'existing-account' });
    expect(account).toEqual(before);
    expect(Object.keys(updateMany.mock.calls[0][0].data)).toEqual(['keyHash']);
  });

  it('requires an administrator, not a valid ordinary API key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/keys/existing-account/rotate',
      headers: { authorization: `Bearer ${oldSecret}` },
      payload: body,
    });
    expect(response.statusCode).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects an incorrect admin token without changing the credential', async () => {
    expect((await rotate(body, 'wrong-admin-token')).statusCode).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { ...body, actor: 'line\nbreak' },
    { ...body, reason: '' },
    { ...body, expectedActive: 'true' },
    { ...body, balanceUsd: '100' },
    { ...body, reactivate: 'true' },
  ])('rejects malformed or account-mutating input: %j', async (payload) => {
    expect((await rotate(payload)).statusCode).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('never implicitly reactivates a revoked identity', async () => {
    row.active = false;
    expect((await rotate({ ...body, expectedActive: false })).statusCode).toBe(409);
    expect(row.active).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('explicit recovery returns a new credential on the original funded identity', async () => {
    row.active = false;
    const before = structuredClone(account);
    const response = await rotate({ ...body, expectedActive: false, reactivate: true });
    expect(response.statusCode).toBe(200);
    const fresh = response.json();
    expect(fresh.id).toBe('existing-account');
    expect(await authenticate(oldSecret)).toBeNull();
    expect(await authenticate(fresh.key)).toMatchObject({ id: 'existing-account' });
    expect(account).toEqual(before);
    expect(row.active).toBe(true);
    expect(Object.keys(updateMany.mock.calls[0][0].data)).toEqual(['keyHash', 'active']);
  });

  it('refuses a stale active-state expectation', async () => {
    expect((await rotate({ ...body, expectedActive: false })).statusCode).toBe(409);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does not issue a credential when another rotation/revocation wins', async () => {
    loseRace = true;
    const response = await rotate();
    expect(response.statusCode).toBe(409);
    expect(response.json()).not.toHaveProperty('key');
    expect(await authenticate(oldSecret)).toMatchObject({ id: row.id });
  });

  it('returns 404 for a nonexistent identity', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/keys/missing/rotate',
      headers: { 'x-admin-token': adminToken },
      payload: body,
    });
    expect(response.statusCode).toBe(404);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects reactivation of an already active identity', async () => {
    expect((await rotate({ ...body, reactivate: true })).statusCode).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
