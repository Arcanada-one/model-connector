import { describe, it, expect } from 'vitest';
import { StrictChatService } from './service';
import { DeepSeekStrictStream, deepSeekSingleSend } from './stream';
import { parseStrictChat, chatDigest } from './contract';
import { SqlStrictIntentStore, IntentRecord, StrictIntentStore } from './store';
/** Labelled local doubles, no provider/account/DB authority. */
const h = 'a'.repeat(64);
function body() {
  return {
    version: 'mc-chat/v1',
    intent: 'logical',
    attempt: 'attempt',
    generation: '7',
    model: 'pinned',
    capability_sha256: h,
    admission_sha256: h,
    rate_sha256: h,
    checkpoint_sha256: h,
    deadline_ms: 20000,
    messages: [{ role: 'user', content: 'offline' }],
    parallel_tool_calls: false,
    thinking: { type: 'disabled' },
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 20,
    input_token_bound: 20,
    output_byte_bound: 8192,
  };
}
class MemoryStore implements StrictIntentStore {
  rows = new Map<string, IntentRecord>();
  lost = false;
  settlementFailure = false;
  async begin(row: IntentRecord) {
    const k = row.tenant + ':' + row.intent;
    const old = this.rows.get(k);
    if (old) return { inserted: false, row: structuredClone(old) };
    this.rows.set(k, structuredClone(row));
    if (this.lost) throw new Error('lost ACK');
    return { inserted: true, row: structuredClone(row) };
  }
  async read(t: string, i: string) {
    return structuredClone(this.rows.get(t + ':' + i) ?? null);
  }
  async finish(
    row: IntentRecord,
    state: 'completed' | 'uncertain',
    receipt: Record<string, unknown>,
  ) {
    if (this.settlementFailure) throw new Error('DB lost');
    const old = this.rows.get(row.tenant + ':' + row.intent);
    if (!old || old.state !== 'dispatch_started') return false;
    old.state = state;
    old.receipt = structuredClone(receipt);
    return true;
  }
}
const frame = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'offline-id', model: 'pinned', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ id: 'offline-id', model: 'pinned', choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`;
const normal =
  frame({ reasoning_content: 'PRIVATE-CONTINUATION' }) +
  frame({ content: '答' }, 'stop') +
  usage +
  'data: [DONE]\n\n';
function setup(payload = normal) {
  const store = new MemoryStore(),
    events: string[] = [];
  let sends = 0,
    valid = true,
    authorized = true,
    clock = 10000;
  const service = new StrictChatService({
    enabled: true,
    store,
    now: () => clock,
    authority: {
      statusAllowed: async (t) => authorized && t === 'tenant',
      acquire: async (t, c, b, d) =>
        authorized && t === 'tenant'
          ? {
              tenant: t,
              connector: c,
              model: b.model,
              digest: d,
              intent: b.intent,
              attempt: b.attempt,
              generation: b.generation,
              deadline_ms: b.deadline_ms,
              exposure: {
                admission: h,
                rate: h,
                checkpoint: h,
                capability: h,
                source: h,
                deployment: h,
                encoder: h,
                hard_output: h,
                units: '123',
                scale: 6,
              },
              current: async () => valid,
              close: async () => {},
              withDispatchFence: async (f) => f(),
            }
          : null,
    },
    transport: new DeepSeekStrictStream(async () => {
      sends++;
      const bytes = new TextEncoder().encode(payload);
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1));
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  });
  return {
    service,
    store,
    events,
    sendCount: () => sends,
    setValid: (v: boolean) => (valid = v),
    setAuth: (v: boolean) => (authorized = v),
    setNow: (v: number) => (clock = v),
    run: (v: unknown = body(), t = 'tenant') =>
      service.execute(
        'deepseek',
        t,
        v,
        async (e) => {
          events.push(e);
        },
        new AbortController().signal,
      ),
  };
}
describe('strict additive source transport', () => {
  it('default disabled and wrong tenant refuse before zero upstream', async () => {
    const x = setup();
    await expect(
      new StrictChatService().execute(
        'deepseek',
        'tenant',
        body(),
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('refused');
    await expect(x.run(body(), 'foreign')).rejects.toThrow();
    expect(x.sendCount()).toBe(0);
  });
  it('real incremental UTF8 with measured receipt, no protected replay/status', async () => {
    const x = setup();
    await x.run();
    expect(x.sendCount()).toBe(1);
    expect(x.events[0]).toContain('PRIVATE-CONTINUATION');
    const status = await x.service.status('tenant', 'logical');
    expect(status?.state).toBe('completed');
    expect(JSON.stringify(status)).not.toContain('PRIVATE-CONTINUATION');
    expect(x.events.at(-1)).toBe('data: [DONE]\n\n');
  });
  it('concurrent repeats/restart cannot redispatch and changed body conflicts', async () => {
    const x = setup();
    const both = await Promise.allSettled([x.run(), x.run()]);
    expect(both.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(x.sendCount()).toBe(1);
    await expect(x.run()).rejects.toThrow('replay_unavailable');
    const changed = body();
    changed.messages[0].content = 'different';
    await expect(x.run(changed)).rejects.toThrow('conflict');
    expect(x.sendCount()).toBe(1);
  });
  it('lost durable dispatch ACK prevents egress and restart', async () => {
    const x = setup();
    x.store.lost = true;
    await expect(x.run()).rejects.toThrow();
    expect(x.sendCount()).toBe(0);
    expect((await x.store.read('tenant', 'logical'))?.state).toBe('dispatch_started');
    x.store.lost = false;
    await expect(x.run()).rejects.toThrow('replay_unavailable');
    expect(x.sendCount()).toBe(0);
  });
  it('DB failure after stream retains pending, never successful DONE', async () => {
    const x = setup();
    x.store.settlementFailure = true;
    await expect(x.run()).rejects.toThrow('uncertain');
    expect((await x.store.read('tenant', 'logical'))?.state).toBe('dispatch_started');
    expect(x.events).not.toContain('data: [DONE]\n\n');
    expect(x.sendCount()).toBe(1);
  });
  it('missing usage retains uncertain rather than default zero', async () => {
    const x = setup(normal.replace(usage, ''));
    await expect(x.run()).rejects.toThrow('uncertain');
    expect((await x.store.read('tenant', 'logical'))?.state).toBe('uncertain');
    expect(x.events).not.toContain('data: [DONE]\n\n');
  });
  it('truncation/model drift refuse with one attempt and retained uncertainty', async () => {
    for (const s of [
      normal.replace('data: [DONE]\n\n', ''),
      normal.replace(/"model":"pinned"/gu, '"model":"drift"'),
    ]) {
      const x = setup(s);
      await expect(x.run()).rejects.toThrow('uncertain');
      expect(x.sendCount()).toBe(1);
      expect((await x.store.read('tenant', 'logical'))?.state).toBe('dispatch_started');
    }
  });
  it('stale fence after blocking durable write denies before zero egress', async () => {
    const x = setup();
    const old = x.store.begin.bind(x.store);
    x.store.begin = async (r) => {
      const out = await old(r);
      x.setValid(false);
      return out;
    };
    await expect(x.run()).rejects.toThrow('uncertain');
    expect(x.sendCount()).toBe(0);
  });
  it('expiry after durable write denies before zero egress', async () => {
    const x = setup();
    const old = x.store.begin.bind(x.store);
    x.store.begin = async (r) => {
      const out = await old(r);
      x.setNow(20000);
      return out;
    };
    await expect(x.run()).rejects.toThrow('uncertain');
    expect(x.sendCount()).toBe(0);
  });
  it('fragmented typed tools preserved; unfinished arguments refused', async () => {
    const s =
      frame({
        tool_calls: [
          {
            index: 0,
            id: 'call',
            type: 'function',
            function: { name: 'lookup', arguments: '{"x":' },
          },
        ],
      }) +
      frame({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, 'tool_calls') +
      usage +
      'data: [DONE]\n\n';
    const b = body() as Record<string, unknown>;
    b.tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const x = setup(s);
    await x.run(b);
    expect(x.sendCount()).toBe(1);
    const bad = setup(s.replace('1}', '1'));
    await expect(bad.run(b)).rejects.toThrow('uncertain');
  });
  it('unknown fields/body overflow/tool IDs/Boolean limits refused', () => {
    for (const value of [
      { ...body(), tenant: 'foreign' },
      { ...body(), max_tokens: true },
      { ...body(), messages: [{ role: 'tool', content: 'x', tool_call_id: 'absent' }] },
      { ...body(), messages: [{ role: 'user', content: 'x'.repeat(9000000) }] },
    ])
      expect(() => parseStrictChat(value)).toThrow();
  });
  it('caller cancellation after first genuine event aborts and retains uncertainty', async () => {
    const x = setup(),
      c = new AbortController();
    await expect(
      x.service.execute(
        'deepseek',
        'tenant',
        body(),
        async (e) => {
          x.events.push(e);
          c.abort();
        },
        c.signal,
      ),
    ).rejects.toThrow('uncertain');
    expect(x.sendCount()).toBe(1);
    expect((await x.store.read('tenant', 'logical'))?.state).toBe('dispatch_started');
  });
  it('authenticated status refuses another tenant and source bytes bind digest', async () => {
    const x = setup();
    await x.run();
    await expect(x.service.status('foreign', 'logical')).rejects.toThrow();
    const a = parseStrictChat(body());
    expect(chatDigest('deepseek', a)).not.toBe(chatDigest('other', a));
  });
  it('429 is one physical send with no timeout/automatic replay exception', async () => {
    const x = setup();
    const transport = new DeepSeekStrictStream(async () => new Response('', { status: 429 }));
    let calls = 0;
    const original = transport.stream.bind(transport);
    transport.stream = async function* (...args) {
      calls++;
      return yield* original(...args);
    };
    // Independent stream port control: no SDK/output-guard loop exists.
    const b = parseStrictChat(body());
    for (let n = 0; n < 1; n++) {
      const g = transport.stream(b, new AbortController().signal, async () => true);
      await expect(g.next()).rejects.toThrow('strict-upstream-refused');
    }
    expect(calls).toBe(1);
    expect(x.sendCount()).toBe(0);
  });
  it('single-fetch wrapper rejects stale credential acquisition and redirects', async () => {
    let current = true,
      calls = 0;
    const send = deepSeekSingleSend(
      async () => {
        current = false;
        return 'OFFLINE-SYNTHETIC-KEY';
      },
      async () => {
        calls++;
        return new Response('');
      },
      async () => current,
    );
    await expect(send({} as never, new AbortController().signal)).rejects.toThrow(
      'strict-key-refused',
    );
    expect(calls).toBe(0);
    const ok = deepSeekSingleSend(
      async () => 'OFFLINE-SYNTHETIC-KEY',
      async (url, init) => {
        calls++;
        expect(url).toBe('https://api.deepseek.com/chat/completions');
        expect(init?.redirect).toBe('error');
        return new Response('');
      },
      async () => true,
    );
    await ok({} as never, new AbortController().signal);
    expect(calls).toBe(1);
  });
  it('stream byte overflow and invalid UTF8 refuse without successful terminal', async () => {
    const x = setup();
    const b = body();
    b.output_byte_bound = 4;
    await expect(x.run(b)).rejects.toThrow('uncertain');
    expect(x.events).not.toContain('data: [DONE]\n\n');
    const transport = new DeepSeekStrictStream(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([255]));
              c.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    await expect(
      transport
        .stream(parseStrictChat(body()), new AbortController().signal, async () => true)
        .next(),
    ).rejects.toThrow();
  });
  it('reasoning continuation and full ordered tool context preserved in exact wire', () => {
    const b = body() as Record<string, unknown>;
    b.thinking = { type: 'enabled' };
    b.tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    b.messages = [
      { role: 'user', content: 'original' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'OPAQUE-OFFLINE',
        tool_calls: [
          { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'result', tool_call_id: 'call' },
    ];
    const parsed = parseStrictChat(b);
    expect(JSON.stringify(parsed.messages)).toContain('OPAQUE-OFFLINE');
    const missing = structuredClone(b);
    delete (missing.messages as Record<string, unknown>[])[1].reasoning_content;
    expect(() => parseStrictChat(missing)).toThrow('chat-continuation-missing');
  });
  it('SQL source requires independently visible exact receipt, not an early ACK', async () => {
    const x = setup();
    await x.run();
    const original = (await x.store.read('tenant', 'logical'))!;
    const row = { ...original, state: 'dispatch_started' as const, receipt: null };
    let stored: Record<string, unknown> | null = null;
    let reads = 0;
    const sql = new SqlStrictIntentStore({
      query: async (statement, values) => {
        if (statement.startsWith('INSERT')) {
          stored = {
            api_key_id: values[0],
            intent_key: values[1],
            attempt: values[2],
            generation: values[3],
            digest: values[4],
            model: values[5],
            connector: values[6],
            state: 'dispatch_started',
            exposure: JSON.parse(values[7] as string),
            receipt: null,
          };
          return { rows: [stored] };
        }
        if (statement.startsWith('SELECT')) {
          reads++;
          return { rows: stored ? [stored] : [] };
        }
        if (statement.startsWith('UPDATE')) {
          stored!.state = values[3];
          stored!.receipt = { wrong: 'not the committed receipt' };
          return { rows: [stored!] };
        }
        throw new Error('unexpected fixture SQL');
      },
    });
    expect((await sql.begin(row)).inserted).toBe(true);
    expect(reads).toBe(1);
    expect(await sql.finish(row, 'completed', { usage: null })).toBe(false);
    expect(reads).toBe(2);
  });
});
