import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { BenchReservationService } from './service';
import { BenchTrustedSocketAdapter } from './adapter';
import { CampaignStore, CheckpointStore } from './store';
import { composeBenchCustody, BenchCustodyCompositionOptions } from './composition';
import { material } from '../../test/bench-reservation/fixture';

const directories: string[] = [];
const lifecycles: NonNullable<ReturnType<typeof composeBenchCustody>>[] = [];
afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.stop();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bench-composition-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'custody.sock');
  const f = material(socketPath); // Existing synthetic source fixture, no live identity.
  const query = vi.fn(() => {
    throw new Error('database access forbidden in lifecycle fixture');
  });
  const connect = vi.fn(() => {
    throw new Error('database access forbidden in lifecycle fixture');
  });
  const pool = { query, connect } as unknown as Pool;
  const dependencies = {
    campaign: new CampaignStore(pool),
    checkpoint: new CheckpointStore(pool),
    issuerPublicKey: f.issuer.publicKey,
    custodianPrivateKey: f.custodian.privateKey,
    authArcanaJwks: f.jwks,
    now: () => f.now,
  };
  return { directory, socketPath, dependencies, query, connect };
}
function own(options: Parameters<typeof composeBenchCustody>[0]) {
  const lifecycle = composeBenchCustody(options)!;
  lifecycles.push(lifecycle);
  return lifecycle;
}
async function malformed(socketPath: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(1000, () => socket.destroy(new Error('fixture deadline')));
    let reply = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.end('{}'));
    socket.on('data', (data) => (reply += data.toString()));
    socket.on('end', () => resolve(reply));
  });
}

describe('default-disabled BENCH custody composition source', () => {
  it('default and false never read owner dependencies or socket path', () => {
    expect(composeBenchCustody()).toBeUndefined();
    for (const enabled of [false, undefined] as const) {
      const options = {
        enabled,
        get dependencies() {
          throw new Error('private deps read');
        },
        get socketPath() {
          throw new Error('path read');
        },
      };
      expect(composeBenchCustody(options)).toBeUndefined();
    }
  });
  it('refuses truthy flag coercion and missing typed dependencies', () => {
    for (const enabled of ['true', 1, null]) {
      expect(() =>
        composeBenchCustody({ enabled } as unknown as BenchCustodyCompositionOptions),
      ).toThrow();
    }
    expect(() =>
      composeBenchCustody({
        enabled: true,
        socketPath: '/owned/missing.sock',
      } as BenchCustodyCompositionOptions),
    ).toThrow();
  });
  it('refuses relative or overlong socket names before opening resources', async () => {
    const f = await fixture();
    for (const socketPath of ['relative.sock', '/' + 'x'.repeat(108)]) {
      expect(() =>
        composeBenchCustody({ enabled: true, dependencies: f.dependencies, socketPath }),
      ).toThrow();
    }
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('refuses missing stores, Auth clock and wrong or shared issuer/signer', async () => {
    const f = await fixture();
    const bad = [
      { campaign: {} },
      { checkpoint: {} },
      { authArcanaJwks: '' },
      { now: undefined },
      { issuerPublicKey: f.dependencies.custodianPrivateKey },
      {
        issuerPublicKey: material(f.socketPath).custodian.publicKey,
        custodianPrivateKey: f.dependencies.issuerPublicKey,
      },
      {
        custodianPrivateKey: material(f.socketPath).issuer.privateKey,
        issuerPublicKey: f.dependencies.issuerPublicKey,
      },
    ];
    // The last case explicitly reuses the issuer's matching private key below.
    const same = material(f.socketPath);
    bad[bad.length - 1] = {
      issuerPublicKey: same.issuer.publicKey,
      custodianPrivateKey: same.issuer.privateKey,
    };
    for (const delta of bad) {
      expect(() =>
        composeBenchCustody({
          enabled: true,
          socketPath: f.socketPath,
          dependencies: { ...f.dependencies, ...delta } as typeof f.dependencies,
        }),
      ).toThrow();
    }
  });
  it('composes real classes without startup provisioning, database access or a socket', async () => {
    const f = await fixture();
    const provision = vi.spyOn(BenchReservationService.prototype, 'provision');
    const reserve = vi.spyOn(BenchReservationService.prototype, 'reserve');
    own({ enabled: true, socketPath: f.socketPath, dependencies: f.dependencies });
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(provision).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('serializes duplicate starts and stop/start around the real local socket', async () => {
    const f = await fixture();
    const start = vi.spyOn(BenchTrustedSocketAdapter.prototype, 'start');
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    expect(await Promise.all([lifecycle.start(), lifecycle.start()])).toEqual([true, true]);
    expect(start).toHaveBeenCalledTimes(1);
    expect((await lstat(f.socketPath)).isSocket()).toBe(true);
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o600);
    expect(await malformed(f.socketPath)).toBe('{"refused":true}');
    await Promise.all([lifecycle.stop(), lifecycle.stop()]);
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lifecycle.start()).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('orders concurrent start then stop without leaking the socket', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    const started = lifecycle.start();
    const stopped = lifecycle.stop();
    expect(await started).toBe(true);
    await stopped;
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves foreign files and refuses an unsafe directory without automatic retry', async () => {
    const f = await fixture();
    const start = vi.spyOn(BenchTrustedSocketAdapter.prototype, 'start');
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await writeFile(f.socketPath, 'existing owner file');
    await expect(lifecycle.start()).rejects.toThrow();
    expect(start).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
    expect(await readFile(f.socketPath, 'utf8')).toBe('existing owner file');
    await unlink(f.socketPath);
    await chmod(f.directory, 0o755);
    await expect(lifecycle.start()).rejects.toThrow();
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('stop preserves a replacement path rather than unlinking another owner', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    await unlink(f.socketPath);
    await writeFile(f.socketPath, 'replacement');
    await lifecycle.stop();
    expect(await readFile(f.socketPath, 'utf8')).toBe('replacement');
  });
});
