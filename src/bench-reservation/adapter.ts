import { createServer, Server, Socket } from 'node:net';
import { lstat, chmod, unlink, mkdtemp, link, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { BenchReservationService } from './service';
import { requestSchema, requireBench } from './contract';
import { digest } from './signatures';
import { wireSchema } from './wire-schema';
import { BenchMonetaryV2Receiver } from './monetary-v2';

const envelopeSchema = z
  .object({
    schema: z.literal('NativeBenchCustodyEnvelope/v1'),
    signed_grant: z.unknown(),
    caller_access_token: z.string().min(1).max(16384),
    request: requestSchema,
    operation_deadline_unix: z.number().int().nonnegative().safe(),
    wire_utf8: z.string().max(10_000_000),
  })
  .strict();
/** A foreign entry remains in private custody if exclusive restoration cannot
 * succeed. The owner gets a recovery path, never a silent delete or overwrite. */
export class BenchSocketCleanupHold extends Error {
  constructor(readonly recoveryPath: string) {
    super('socket_cleanup_held');
  }
}
export class BenchTrustedSocketAdapter {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private privateDirectory?: string;
  private identity?: { dev: number; ino: number };
  private published = false;
  private starting = false;
  constructor(
    private readonly service: BenchReservationService,
    private readonly socketPath: string,
    private readonly monetaryV2?: BenchMonetaryV2Receiver,
  ) {}
  async reserveEnvelope(raw: unknown) {
    if (raw !== null && typeof raw === 'object' &&
        (raw as { schema?: unknown }).schema === 'NativeBenchCustodyEnvelope/v2') {
      requireBench(this.monetaryV2, 'monetary_executor_not_bound');
      return this.monetaryV2.reserveEnvelope(raw);
    }
    const value = envelopeSchema.parse(raw);
    const grant = this.service.inspectAuthority(value.signed_grant, value.caller_access_token);
    requireBench(grant.custodian_socket === this.socketPath, 'socket_not_grant_bound');
    const bytes = Buffer.from(value.wire_utf8, 'utf8');
    requireBench(bytes.toString('utf8') === value.wire_utf8, 'invalid_wire_utf8');
    requireBench(
      bytes.length === value.request.reserved[1] && digest(bytes) === value.request.wire_sha256,
      'actual_wire_not_bound',
    );
    wireSchema.parse(JSON.parse(value.wire_utf8));
    // The raw native byte envelope, not a caller estimate, supplies input charge.
    // MC verifies grant/model/account/build/subject/attempt/nonce and hard output.
    return this.service.reserve(
      value.signed_grant,
      value.request,
      value.caller_access_token,
      value.operation_deadline_unix,
    );
  }
  /** Default disabled, no env/key loading, issuer, token generation, HTTP route,
   * provider path or AppModule activation. Owner supplies existing service. */
  async start(enabled = false): Promise<boolean> {
    if (!enabled) return false;
    requireBench(
      !this.server && !this.privateDirectory && !this.starting && isAbsolute(this.socketPath),
      'socket_start_refused',
    );
    requireBench(Buffer.byteLength(this.socketPath) < 108, 'socket_path_too_long');
    this.starting = true;
    try {
      const parent = await lstat(dirname(this.socketPath));
      requireBench(
        parent.isDirectory() &&
          !parent.isSymbolicLink() &&
          parent.uid === process.getuid?.() &&
          (parent.mode & 0o777) === 0o700,
        'private_socket_directory_required',
      );
      try {
        await lstat(this.socketPath);
        throw new Error('existing socket preserved');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Node/libuv unlinks the name supplied to listen() during close(), without
      // comparing inode identity. Never give it the grant-visible mutable name.
      // Same-filesystem hardlink publication preserves the exact filesystem socket
      // and signed grant path; no symlink, abstract socket, private handle or proxy.
      requireBench(
        Buffer.byteLength(join(dirname(this.socketPath), '.b-XXXXXX', 's')) < 108,
        'private_socket_path_too_long',
      );
      this.privateDirectory = await mkdtemp(join(dirname(this.socketPath), '.b-'));
      const boundPath = join(this.privateDirectory, 's');
      const server = createServer({ allowHalfOpen: true }, (socket) => this.handle(socket));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(boundPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await chmod(boundPath, 0o600);
      const bound = await lstat(boundPath);
      this.identity = { dev: bound.dev, ino: bound.ino };
      await link(boundPath, this.socketPath); // Exclusive: existing entries are never replaced.
      this.published = true;
      return true;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.starting = false;
    }
  }
  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    // No payload/token/key/error logging. A timeout may lose a committed reply;
    // the service still preserves every UNKNOWN reservation without release.
    const chunks: Buffer[] = [];
    let length = 0;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) socket.destroy();
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      void (async () => {
        try {
          requireBench(!socket.destroyed, 'socket_deadline_expired');
          const result = await this.reserveEnvelope(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          );
          if (!socket.destroyed) socket.end(JSON.stringify(result));
        } catch {
          if (!socket.destroyed) socket.end('{"refused":true}');
        }
      })();
    });
  }
  private async releasePublicName(directory: string): Promise<void> {
    const captured = join(directory, 'captured');
    try {
      await lstat(captured);
      throw new BenchSocketCleanupHold(captured); // Preserve unresolved prior custody.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!this.published) return;
    try {
      const current = await lstat(this.socketPath);
      if (!this.ownsSocket(current)) return; // Already foreign: leave it exactly where it is.
      await rename(this.socketPath, captured); // Capture the actual entry, not an earlier check.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const actual = await lstat(captured);
    if (!this.ownsSocket(actual)) {
      try {
        // link() is no-clobber and does not follow a captured symlink on Linux.
        // Directory replacements or an occupied public name remain held, never deleted.
        await link(captured, this.socketPath);
      } catch {
        throw new BenchSocketCleanupHold(captured);
      }
    }
    await unlink(captured); // Only private captured custody; never unlink the public name.
  }
  private ownsSocket(value: { dev: number; ino: number; isSocket(): boolean }): boolean {
    return value.isSocket() && value.dev === this.identity?.dev && value.ino === this.identity?.ino;
  }
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      for (const socket of this.sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(error)
            : resolve(),
        ),
      );
    }
    const directory = this.privateDirectory;
    if (!directory) return;
    await this.releasePublicName(directory);
    // No recursive cleanup: any unexpected entry preserves the private directory
    // and blocks a restart until owner recovery. Explicit stop can finish cleanup
    // after that recovery; it never releases an UNKNOWN financial reservation.
    await rmdir(directory);
    this.privateDirectory = undefined;
    this.identity = undefined;
    this.published = false;
  }
}
