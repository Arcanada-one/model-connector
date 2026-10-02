import { createServer, Server, Socket } from 'node:net';
import { lstat, chmod, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { BenchReservationService } from './service';
import { requestSchema, requireBench } from './contract';
import { digest } from './signatures';

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
const textContent = z
  .object({ type: z.enum(['input_text', 'output_text']), text: z.string() })
  .strict();
const message = z
  .object({
    type: z.literal('message').optional(),
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(textContent)]),
  })
  .strict();
const input = z.union([z.string(), z.array(message)]);
/** This is an admissible text-only source schema, not a measured provider token
 * bound. Unknown input variants refuse; original corpus may not be truncated. */
const wireSchema = z
  .object({
    model: z.literal('gpt-6-luna'),
    input,
    instructions: z.string().optional(),
    tools: z.array(z.never()).optional(),
    tool_choice: z.enum(['auto', 'none']).optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({
        effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
        summary: z.enum(['auto', 'concise', 'detailed']).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    store: z.literal(false).optional(),
    stream: z.literal(true).optional(),
    stream_options: z.object({ include_usage: z.boolean() }).strict().optional(),
    include: z.array(z.literal('reasoning.encrypted_content')).optional(),
    service_tier: z.literal('auto').optional(),
    prompt_cache_key: z.string().optional(),
    text: z
      .object({
        verbosity: z.enum(['low', 'medium', 'high']).optional(),
        format: z
          .object({
            type: z.enum(['text', 'json_schema']),
            strict: z.boolean().optional(),
            schema: z.record(z.string(), z.unknown()).optional(),
            name: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    client_metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export class BenchTrustedSocketAdapter {
  private server?: Server;
  private inode?: number;
  constructor(
    private readonly service: BenchReservationService,
    private readonly socketPath: string,
  ) {}
  async reserveEnvelope(raw: unknown) {
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
    requireBench(!this.server && isAbsolute(this.socketPath), 'socket_start_refused');
    requireBench(Buffer.byteLength(this.socketPath) < 108, 'socket_path_too_long');
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
    const server = createServer({ allowHalfOpen: true }, (socket) => this.handle(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await chmod(this.socketPath, 0o600);
      this.inode = (await lstat(this.socketPath)).ino;
      return true;
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
  }
  private handle(socket: Socket): void {
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
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    try {
      const s = await lstat(this.socketPath);
      if (s.ino === this.inode && s.isSocket()) await unlink(this.socketPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
