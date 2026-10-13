/** reuse: tenant-scoped MC auth identity, closed chat DTO and separate supplier intent store.
 * No provider registration, pool, issuer, credential loader or default runtime activation. */
import { isDeepStrictEqual } from 'node:util';
import { StrictChatRequest, parseStrictChat, chatDigest } from './contract';
import { IntentRecord, StrictIntentStore, SupplierPin } from './store';
import { safeUsage, StrictTransport, StreamSummary } from './stream';
export const STRICT_CHAT_BOUNDARY = Symbol('STRICT_CHAT_BOUNDARY');
export interface StrictAuthorityLease {
  tenant: string;
  connector: string;
  model: string;
  digest: string;
  deadline_ms: number;
  intent: string;
  attempt: string;
  generation: string;
  exposure: SupplierPin;
  /** Original verifier supplies authenticated account/grant/rates/tokenizer/hard-output/current policy.
   * Method presence is not qualification. Hold actual all-writer/revoker exclusion through callback. */
  current(): Promise<boolean>;
  withDispatchFence<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface StrictAuthority {
  acquire(
    tenant: string,
    connector: string,
    body: StrictChatRequest,
    digest: string,
  ): Promise<StrictAuthorityLease | null>;
  statusAllowed(tenant: string, intent: string): Promise<boolean>;
}
export class StrictChatError extends Error {
  constructor(readonly code: 'refused' | 'conflict' | 'replay_unavailable' | 'uncertain') {
    super(code);
  }
}
const sha = /^[a-f0-9]{64}$/u;
export class StrictChatService {
  constructor(
    private readonly ports: {
      enabled?: boolean;
      authority?: StrictAuthority;
      store?: StrictIntentStore;
      transport?: StrictTransport;
      now?: () => number;
    } = {},
  ) {}
  async status(tenant: string, intent: string) {
    const p = this.ports;
    if (
      !p.enabled ||
      !tenant ||
      !p.authority ||
      !p.store ||
      !(await p.authority.statusAllowed(tenant, intent))
    )
      throw new StrictChatError('refused');
    const row = await p.store.read(tenant, intent);
    if (!(await p.authority.statusAllowed(tenant, intent))) throw new StrictChatError('refused');
    if (row && (row.tenant !== tenant || row.intent !== intent))
      throw new StrictChatError('refused');
    return row
      ? {
          version: 'mc-chat/v1',
          intent: row.intent,
          digest: row.digest,
          state: row.state,
          receipt: row.receipt
            ? Object.fromEntries(
                [
                  'version',
                  'intent',
                  'attempt',
                  'generation',
                  'digest',
                  'requested_model',
                  'served_model',
                  'provider_id',
                  'finish',
                  'usage',
                  'dispatch_count',
                  'state',
                ]
                  .filter((k) => k in row.receipt!)
                  .map((k) => [k, k === 'usage' ? safeUsage(row.receipt![k]) : row.receipt![k]]),
              )
            : null,
          replay: 'unavailable',
        }
      : null;
  }
  async execute(
    connector: string,
    tenant: string,
    raw: unknown,
    sink: (event: string, signal: AbortSignal) => Promise<void>,
    callerSignal: AbortSignal,
  ) {
    const p = this.ports;
    if (
      p.enabled !== true ||
      !tenant ||
      tenant === 'unknown' ||
      connector !== 'deepseek' ||
      !p.authority ||
      !p.store ||
      !p.transport ||
      !p.now
    )
      throw new StrictChatError('refused');
    let body: StrictChatRequest;
    try {
      body = parseStrictChat(raw);
    } catch {
      throw new StrictChatError('refused');
    }
    const digest = chatDigest(connector, body),
      now = p.now;
    if (callerSignal.aborted || now() >= body.deadline_ms || body.deadline_ms - now() > 600000)
      throw new StrictChatError('refused');
    const lease = await p.authority.acquire(tenant, connector, structuredClone(body), digest);
    if (!lease) throw new StrictChatError('refused');
    const frozen = structuredClone({
      tenant: lease.tenant,
      connector: lease.connector,
      model: lease.model,
      digest: lease.digest,
      deadline_ms: lease.deadline_ms,
      intent: lease.intent,
      attempt: lease.attempt,
      generation: lease.generation,
      exposure: lease.exposure,
    });
    const c = new AbortController();
    const abort = () => c.abort();
    callerSignal.addEventListener('abort', abort, { once: true });
    // acquire may have blocked across the original caller cancellation event.
    if (callerSignal.aborted) abort();
    const timer = setTimeout(abort, Math.max(0, body.deadline_ms - now()));
    let row: IntentRecord | null = null,
      started = false;
    const current = async () =>
      !callerSignal.aborted &&
      !c.signal.aborted &&
      now() < body.deadline_ms &&
      now() < lease.deadline_ms &&
      lease.digest === digest &&
      lease.tenant === tenant &&
      lease.generation === body.generation &&
      (await lease.current()) === true &&
      !callerSignal.aborted &&
      !c.signal.aborted &&
      now() < body.deadline_ms;
    try {
      const x = frozen.exposure;
      if (
        frozen.tenant !== tenant ||
        frozen.connector !== connector ||
        frozen.model !== body.model ||
        frozen.digest !== digest ||
        frozen.intent !== body.intent ||
        frozen.attempt !== body.attempt ||
        frozen.generation !== body.generation ||
        frozen.deadline_ms < body.deadline_ms ||
        !Number.isSafeInteger(frozen.deadline_ms) ||
        !x ||
        !/^\d{1,38}$/u.test(x.units) ||
        !Number.isInteger(x.scale) ||
        x.scale < 0 ||
        x.scale > 18 ||
        ![
          'admission',
          'rate',
          'checkpoint',
          'capability',
          'source',
          'deployment',
          'encoder',
          'hard_output',
        ].every((k) => sha.test(x[k as keyof SupplierPin] as string)) ||
        x.admission !== body.admission_sha256 ||
        x.rate !== body.rate_sha256 ||
        x.checkpoint !== body.checkpoint_sha256 ||
        x.capability !== body.capability_sha256 ||
        !(await current())
      )
        throw new StrictChatError('refused');
      return await lease.withDispatchFence(async () => {
        if (!(await current())) throw new StrictChatError('refused');
        row = {
          tenant,
          intent: body.intent,
          attempt: body.attempt,
          generation: body.generation,
          digest,
          model: body.model,
          connector,
          state: 'dispatch_started',
          exposure: frozen.exposure,
          receipt: null,
        };
        const claimed = await p.store!.begin(row);
        if (
          claimed.row.tenant !== tenant ||
          claimed.row.intent !== body.intent ||
          claimed.row.digest !== digest
        )
          throw new StrictChatError('conflict');
        if (!claimed.inserted) throw new StrictChatError('replay_unavailable'); // restart/timeout/429 never grants another provider attempt
        started = true;
        if (!isDeepStrictEqual(claimed.row, row) || !(await current()))
          throw new StrictChatError('uncertain');
        const stream = p.transport!.stream(body, c.signal, current);
        let summary: StreamSummary;
        try {
          while (true) {
            const step = await stream.next();
            if (step.done) {
              summary = step.value;
              break;
            }
            if (!(await current())) throw new StrictChatError('uncertain');
            await sink(step.value, c.signal);
          }
        } finally {
          await stream.return(undefined as never).catch(() => undefined);
        }
        if (!(await current())) throw new StrictChatError('uncertain');
        const safe = {
          version: 'mc-chat/v1',
          intent: body.intent,
          attempt: body.attempt,
          generation: body.generation,
          digest,
          requested_model: body.model,
          served_model: summary.served_model,
          provider_id: summary.provider_id,
          finish: summary.finish,
          usage: summary.usage,
          dispatch_count: 1,
          exposure: frozen.exposure,
          state: summary.usage ? 'completed' : 'uncertain',
        };
        const state = summary.usage ? 'completed' : 'uncertain';
        if (
          !(await p.store!.finish(row, state, safe)) ||
          !(await current()) ||
          state !== 'completed'
        )
          throw new StrictChatError('uncertain');
        await sink(`event: receipt\ndata: ${JSON.stringify(safe)}\n\n`, c.signal);
        await sink('data: [DONE]\n\n', c.signal); // only after authentic-supplied committed safe receipt; no fabricated upstream usage
        return safe;
      });
    } catch (error) {
      // No write after the supplied exclusion callback has unwound. A durable
      // dispatch_started row remains UNKNOWN on failure, even if phase update is impossible.
      // No release, TTL reclaim, reconnect, customer-credit write or protected-response replay.
      throw error instanceof StrictChatError
        ? error
        : new StrictChatError(started ? 'uncertain' : 'refused');
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', abort);
      c.abort();
      await lease.close().catch(() => undefined);
    }
  }
}
