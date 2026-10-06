/** reuse: DeepSeek official chat SSE protocol; supplied transport, no SDK retry/default credentials. */
import { z } from 'zod';
import { StrictChatRequest, providerBody } from './contract';
const usageSchema = z
  .object({
    prompt_tokens: z.number().int().safe().nonnegative(),
    completion_tokens: z.number().int().safe().nonnegative(),
    total_tokens: z.number().int().safe().nonnegative(),
  })
  .strip();
export function safeUsage(value: unknown) {
  return value === null ? null : usageSchema.parse(value);
}
export interface StreamSummary {
  served_model: string;
  provider_id: string | null;
  finish: string;
  usage: z.infer<typeof usageSchema> | null;
  bytes: number;
}
export interface StrictTransport {
  stream(
    body: StrictChatRequest,
    signal: AbortSignal,
    current: () => Promise<boolean>,
  ): AsyncGenerator<string, StreamSummary>;
}
/** A trusted incumbent supplies this send port using its existing isolated credentials.
 * It MUST perform one physical request, no redirects/retry/reconnect. No default send. */
export type SingleSend = (
  body: ReturnType<typeof providerBody>,
  signal: AbortSignal,
) => Promise<Response>;
/** Source composition constructor. Credentials are supplied by original custodian,
 * never loaded/minted/logged. Fixed official endpoint, redirect error, one fetch invocation. */
export function deepSeekSingleSend(
  credential: () => Promise<string>,
  fetchOnce: typeof fetch,
  current: () => Promise<boolean>,
): SingleSend {
  return async (body, signal) => {
    const key = await credential();
    if (signal.aborted || !key || /[\r\n]/u.test(key) || !(await current()) || signal.aborted)
      throw new Error('strict-key-refused');
    return fetchOnce('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  };
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('strict-aborted');
  let cancel: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('strict-aborted'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
export class DeepSeekStrictStream implements StrictTransport {
  constructor(private readonly send: SingleSend) {}
  async *stream(
    body: StrictChatRequest,
    signal: AbortSignal,
    current: () => Promise<boolean>,
  ): AsyncGenerator<string, StreamSummary> {
    if (signal.aborted || !(await current())) throw new Error('strict-egress-refused');
    const response = await abortable(this.send(providerBody(body), signal), signal); // sole invocation; no retry, fallback or repair loop
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.startsWith('text/event-stream')
    )
      throw new Error('strict-upstream-refused');
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '',
      bytes = 0,
      finish: string | null = null,
      usage: StreamSummary['usage'] = null,
      providerId: string | null = null,
      done = false,
      visible = false;
    const tools = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      while (!done) {
        if (signal.aborted || !(await current())) throw new Error('strict-stream-revoked');
        const read = await abortable(reader.read(), signal);
        if (read.done) {
          buffer += decoder.decode();
          break;
        }
        bytes += read.value.byteLength;
        if (bytes > body.output_byte_bound) throw new Error('strict-output-overflow');
        buffer += decoder.decode(read.value, { stream: true });
        if (Buffer.byteLength(buffer) > 65536) throw new Error('strict-event-overflow');
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/u)) >= 0) {
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)![0];
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + separator.length);
          const lines = event.split(/\r?\n/u).filter((l) => !l.startsWith(':'));
          if (!lines.length) continue;
          if (lines.some((l) => !l.startsWith('data:'))) throw new Error('strict-frame-refused');
          const data = lines.map((l) => l.slice(5).trimStart()).join('\n');
          if (data === '[DONE]') {
            if (!finish) throw new Error('strict-finish-missing');
            done = true;
            break;
          }
          if (finish && usage !== null) throw new Error('strict-after-final-refused');
          const c = JSON.parse(data);
          if (!c || c.model !== body.model || !Array.isArray(c.choices) || c.choices.length !== 1)
            throw new Error('strict-model-or-choice-refused');
          if (typeof c.id === 'string') {
            if (providerId && providerId !== c.id) throw new Error('strict-id-drift');
            providerId = c.id;
          }
          for (const choice of c.choices) {
            if (choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object')
              throw new Error('strict-delta-refused');
            const delta = choice.delta;
            if (
              Object.keys(delta).some(
                (k) => !['role', 'content', 'reasoning_content', 'tool_calls'].includes(k),
              )
            )
              throw new Error('strict-delta-field-refused');
            if (delta.role != null && delta.role !== 'assistant')
              throw new Error('strict-role-refused');
            for (const field of ['content', 'reasoning_content'])
              if (delta[field] != null && typeof delta[field] !== 'string')
                throw new Error('strict-text-refused');
            if (delta.content) visible = true;
            if (finish && Object.keys(delta).length) throw new Error('strict-content-after-finish');
            for (const t of delta.tool_calls ?? []) {
              if (
                !Number.isSafeInteger(t.index) ||
                t.index < 0 ||
                t.index >= 32 ||
                (t.type !== undefined && t.type !== 'function')
              )
                throw new Error('strict-tool-refused');
              const prior = tools.get(t.index) ?? { id: '', name: '', arguments: '' };
              if (t.id !== undefined) {
                if (prior.id || typeof t.id !== 'string') throw new Error('strict-tool-id-refused');
                prior.id = t.id;
              }
              if (t.function?.name !== undefined) {
                if (prior.name || typeof t.function.name !== 'string')
                  throw new Error('strict-tool-name-refused');
                prior.name = t.function.name;
              }
              if (t.function?.arguments !== undefined) {
                if (typeof t.function.arguments !== 'string')
                  throw new Error('strict-tool-arguments-refused');
                prior.arguments += t.function.arguments;
              }
              if (Buffer.byteLength(prior.arguments) > 262144)
                throw new Error('strict-tool-overflow');
              tools.set(t.index, prior);
            }
            if (choice.finish_reason != null) {
              if (finish || !['stop', 'tool_calls'].includes(choice.finish_reason))
                throw new Error('strict-finish-refused');
              finish = choice.finish_reason;
            }
          }
          if (c.usage != null) {
            const terminal = c.choices[0];
            if (
              !finish ||
              terminal.finish_reason !== finish ||
              (terminal.delta.content != null && terminal.delta.content !== '') ||
              (terminal.delta.reasoning_content != null &&
                terminal.delta.reasoning_content !== '') ||
              (terminal.delta.tool_calls != null && terminal.delta.tool_calls.length !== 0)
            )
              throw new Error('strict-usage-order');
            if (usage) throw new Error('strict-duplicate-usage');
            usage = usageSchema.parse(c.usage);
            if (
              usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens ||
              usage.completion_tokens > body.max_tokens ||
              usage.prompt_tokens > body.input_token_bound
            )
              throw new Error('strict-usage-refused');
          }
          if (!(await current()) || signal.aborted) throw new Error('strict-delivery-refused');
          yield `data: ${data}\n\n`; // protected continuation goes only to active caller, never durable receipt/replay/log
        }
      }
      if (!done || !finish || buffer.trim()) throw new Error('strict-truncated');
      if (finish === 'tool_calls') {
        if (!tools.size) throw new Error('strict-tool-finish-empty');
        const ids = new Set<string>();
        for (const t of tools.values()) {
          if (
            !/^[A-Za-z0-9_-]{1,128}$/u.test(t.id) ||
            ids.has(t.id) ||
            !body.tools?.some((f) => f.function.name === t.name)
          )
            throw new Error('strict-tool-binding-refused');
          ids.add(t.id);
          JSON.parse(t.arguments);
        }
      } else if (tools.size || !visible) throw new Error('strict-empty-completion');
      return { served_model: body.model, provider_id: providerId, finish, usage, bytes };
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
