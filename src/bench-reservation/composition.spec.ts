import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, Server } from 'node:net';
import * as filesystem from 'node:fs/promises';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { BenchReservationService } from './service';
import { BenchTrustedSocketAdapter } from './adapter';
import { CampaignStore, CheckpointStore } from './store';
import { composeBenchCustody, BenchCustodyCompositionOptions } from './composition';
import { material } from '../../test/bench-reservation/fixture';

// Deterministic interleavings keep real filesystem operations; only the exact
// boundary inserts an owned fixture replacement before/after the real syscall.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});

const directories: string[] = [];
const lifecycles: NonNullable<ReturnType<typeof composeBenchCustody>>[] = [];
afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.stop();
  vi.restoreAllMocks();
  vi.clearAllMocks();
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
    const privateNames = (await filesystem.readdir(f.directory)).filter((name) =>
      name.startsWith('.b-'),
    );
    expect(privateNames).toHaveLength(1);
    const privateDirectory = join(f.directory, privateNames[0]);
    expect((await lstat(privateDirectory)).mode & 0o777).toBe(0o700);
    const actual = await lstat(join(privateDirectory, 's'));
    const published = await lstat(f.socketPath);
    expect(actual.ino).toBe(published.ino);
    expect(actual.dev).toBe(published.dev);
    expect(published.nlink).toBe(2);
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
  it('close never unlinks a public replacement introduced at the actual close boundary', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    const originalClose = Server.prototype.close;
    const closed = vi.spyOn(Server.prototype, 'close').mockImplementationOnce(function (
      this: Server,
      callback,
    ) {
      expect(this.address()).not.toBe(f.socketPath);
      unlinkSync(f.socketPath);
      writeFileSync(f.socketPath, 'close-boundary replacement');
      return originalClose.call(this, callback);
    });
    await lifecycle.stop();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(await readFile(f.socketPath, 'utf8')).toBe('close-boundary replacement');
    expect(await filesystem.readdir(f.directory)).toEqual(['custody.sock']);
  });
  it('atomic capture restores a foreign file swapped after the ownership observation', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    const actualRename = (await vi.importActual<typeof filesystem>('node:fs/promises')).rename;
    const captured = vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => {
      await unlink(f.socketPath);
      await writeFile(f.socketPath, 'capture-boundary replacement');
      await actualRename(from, to);
    });
    await lifecycle.stop();
    expect(captured).toHaveBeenCalledTimes(1);
    expect(await readFile(f.socketPath, 'utf8')).toBe('capture-boundary replacement');
    expect(await filesystem.readdir(f.directory)).toEqual(['custody.sock']);
  });
  it('a new public entry created after atomic capture is preserved', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    const actualRename = (await vi.importActual<typeof filesystem>('node:fs/promises')).rename;
    const captured = vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => {
      await actualRename(from, to);
      await writeFile(f.socketPath, 'post-capture replacement');
    });
    await lifecycle.stop();
    expect(captured).toHaveBeenCalledTimes(1);
    expect(await readFile(f.socketPath, 'utf8')).toBe('post-capture replacement');
  });
  it('conflicting foreign capture is held without deleting or overwriting either entry', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    const actualRename = (await vi.importActual<typeof filesystem>('node:fs/promises')).rename;
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => {
      await unlink(f.socketPath);
      await writeFile(f.socketPath, 'captured foreign');
      await actualRename(from, to);
      await writeFile(f.socketPath, 'newer foreign');
    });
    let recoveryPath = '';
    try {
      await lifecycle.stop();
    } catch (error) {
      expect(error).toMatchObject({ message: 'socket_cleanup_held' });
      recoveryPath = (error as { recoveryPath: string }).recoveryPath;
    }
    expect(recoveryPath).not.toBe('');
    expect(await readFile(recoveryPath, 'utf8')).toBe('captured foreign');
    expect(await readFile(f.socketPath, 'utf8')).toBe('newer foreign');
    await expect(lifecycle.start()).rejects.toThrow();
    // Explicit recovery of synthetic owned fixture only. No production recovery/reset.
    await filesystem.rename(recoveryPath, join(f.directory, 'recovered-foreign'));
    await lifecycle.stop();
    expect(await readFile(join(f.directory, 'recovered-foreign'), 'utf8')).toBe('captured foreign');
  });
  it('preserves a foreign replacement socket and its actual listening server', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    await unlink(f.socketPath);
    const foreign = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('data', () => undefined);
      socket.on('end', () => socket.end('foreign fixture'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        foreign.once('error', reject);
        foreign.listen(f.socketPath, resolve);
      });
      const before = await lstat(f.socketPath);
      await lifecycle.stop();
      expect((await lstat(f.socketPath)).ino).toBe(before.ino);
      expect(foreign.listening).toBe(true);
      expect(await malformed(f.socketPath)).toBe('foreign fixture');
    } finally {
      await new Promise<void>((resolve, reject) =>
        foreign.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('preserves replacement symlink and nonempty directory without following or recursively removing them', async () => {
    for (const kind of ['symlink', 'directory']) {
      const f = await fixture();
      const lifecycle = own({
        enabled: true,
        socketPath: f.socketPath,
        dependencies: f.dependencies,
      });
      await lifecycle.start();
      await unlink(f.socketPath);
      if (kind === 'symlink') {
        await writeFile(join(f.directory, 'target'), 'target');
        await filesystem.symlink('target', f.socketPath);
      } else {
        await filesystem.mkdir(f.socketPath);
        await writeFile(join(f.socketPath, 'marker'), 'foreign directory');
      }
      await lifecycle.stop();
      if (kind === 'symlink') {
        expect(await filesystem.readlink(f.socketPath)).toBe('target');
        expect(await readFile(join(f.directory, 'target'), 'utf8')).toBe('target');
      } else expect(await readFile(join(f.socketPath, 'marker'), 'utf8')).toBe('foreign directory');
    }
  });
  it('publication collision refuses without overwriting the new entry or leaving a listener', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    const actualLink = (await vi.importActual<typeof filesystem>('node:fs/promises')).link;
    vi.mocked(filesystem.link).mockImplementationOnce(async (from, to) => {
      await writeFile(f.socketPath, 'publication collision');
      await actualLink(from, to);
    });
    await expect(lifecycle.start()).rejects.toThrow();
    expect(await readFile(f.socketPath, 'utf8')).toBe('publication collision');
    expect(await filesystem.readdir(f.directory)).toEqual(['custody.sock']);
  });
  it('stop closes an actual partial-envelope connection without database access or idle wait', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    const client = createConnection(f.socketPath);
    client.on('error', () => undefined);
    const connected = new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await connected;
    client.write('{');
    await lifecycle.stop();
    await closed;
    expect(f.query).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await filesystem.readdir(f.directory)).toEqual([]);
  });
  it('captured symlink restoration does not follow or modify the target', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    await writeFile(join(f.directory, 'target'), 'target remains');
    const actualRename = (await vi.importActual<typeof filesystem>('node:fs/promises')).rename;
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => {
      await unlink(f.socketPath);
      await filesystem.symlink('target', f.socketPath);
      await actualRename(from, to);
    });
    await lifecycle.stop();
    expect(await filesystem.readlink(f.socketPath)).toBe('target');
    expect(await readFile(join(f.directory, 'target'), 'utf8')).toBe('target remains');
  });
  it('a captured nonempty directory is held with its contents until explicit fixture recovery', async () => {
    const f = await fixture();
    const lifecycle = own({
      enabled: true,
      socketPath: f.socketPath,
      dependencies: f.dependencies,
    });
    await lifecycle.start();
    const actualRename = (await vi.importActual<typeof filesystem>('node:fs/promises')).rename;
    vi.mocked(filesystem.rename).mockImplementationOnce(async (from, to) => {
      await unlink(f.socketPath);
      await filesystem.mkdir(f.socketPath);
      await writeFile(join(f.socketPath, 'marker'), 'held directory');
      await actualRename(from, to);
    });
    let recoveryPath = '';
    try {
      await lifecycle.stop();
    } catch (error) {
      recoveryPath = (error as { recoveryPath: string }).recoveryPath;
    }
    expect(recoveryPath).not.toBe('');
    expect(await readFile(join(recoveryPath, 'marker'), 'utf8')).toBe('held directory');
    await expect(lifecycle.start()).rejects.toThrow();
    // Explicit restoration in an owned synthetic fixture; adapter never overwrites to restore.
    await actualRename(recoveryPath, f.socketPath);
    await lifecycle.stop();
    expect(await readFile(join(f.socketPath, 'marker'), 'utf8')).toBe('held directory');
  });
  it('direct adapter duplicate start is refused before asynchronous resource creation', async () => {
    const f = await fixture();
    const adapter = new BenchTrustedSocketAdapter(
      new BenchReservationService(f.dependencies),
      f.socketPath,
    );
    try {
      const results = await Promise.allSettled([adapter.start(true), adapter.start(true)]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      expect(await malformed(f.socketPath)).toBe('{"refused":true}');
    } finally {
      await adapter.stop();
    }
    expect(await filesystem.readdir(f.directory)).toEqual([]);
  });
});
