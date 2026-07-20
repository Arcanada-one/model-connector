# How-to: TypeScript SDK (`@arcanada/model-connector-sdk`)

This guide walks a TypeScript / Node.js consumer through every supported workflow against `connector.arcanada.ai`.

## Install

```bash
pnpm add @arcanada/model-connector-sdk
```

Requirements: Node.js **>= 20** (the SDK uses the global `fetch` powered by `undici` internally). Zero runtime dependencies.

## Authenticate

The SDK uses Bearer authentication. Obtain an API key from `POST /admin/keys` (operator-only) or from your Arcanada account.

```ts
import { Client } from '@arcanada/model-connector-sdk';

const client = new Client({
  apiKey: process.env.ARC_API_KEY!,
  // baseUrl: 'https://connector.arcanada.ai', // default
  // timeoutMs: 120_000,                          // default
});
```

The SDK redacts `Bearer ...` substrings and any `Authorization` keys from `err.cause` before throwing, so you can log errors safely.

## Execute a prompt

```ts
const response = await client.execute({
  connector: 'openrouter',
  model: 'mistralai/mistral-small-3.2-24b-instruct',
  prompt: 'Summarise BGE-M3 retrieval characteristics in 40 words.',
});

console.log(response.result);
console.log(response.usage); // { inputTokens, outputTokens, totalTokens, costUsd }
console.log(response.latencyMs);
```

Successful responses return **HTTP 201** — the SDK parses them transparently.

## Structured output with `output_format` + `schema`

The `output_format` field activates the output-guard middleware. Combine it with `schema` to constrain the JSON shape:

```ts
const response = await client.execute({
  connector: 'openrouter',
  prompt: "List 3 cities with population, return JSON.",
  output_format: 'json',
  schema: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        population: { type: 'integer' },
      },
      required: ['city', 'population'],
    },
  },
});

console.log(response.repair_report);
// {
//   strategies_applied: ['strip_fences'],
//   retries: 0,
//   final_valid: true,
//   pass: 'guarded',
// }
console.log(response.structured);
```

`repair_report.pass` semantics:

- `native` — the provider's structured output passed schema validation immediately, with **no** repair strategy applied.
- `guarded` — output-guard repaired the response (fence stripping, trailing-comma fix, etc.) and the final value is valid.
- `failed` — output-guard exhausted retries; the SDK throws `GuardExhaustedError`.

`output_format` accepts `json`, `yaml`, `toml`, `python`, or `auto`. `schema` is optional and bounded by a 32 KiB serialized-size limit (server-side).

## Error handling

```ts
import {
  Client,
  ConnectorError,
  GuardExhaustedError,
  TimeoutError,
} from '@arcanada/model-connector-sdk';

try {
  const response = await client.execute({ connector: 'openrouter', prompt: '...' });
} catch (err) {
  if (err instanceof GuardExhaustedError) {
    // output-guard middleware gave up — inspect repair_report on the response
    // is not possible here because the response was rejected. Use err.envelope.
    console.error('guard exhausted', err.envelope?.message);
  } else if (err instanceof TimeoutError) {
    console.error('timeout');
  } else if (err instanceof ConnectorError) {
    console.error('http', err.status, err.envelope?.type);
    if (err.envelope?.retryable && err.retryAfter) {
      // wait err.retryAfter seconds before retrying
    }
  } else {
    throw err;
  }
}
```

The full set of `envelope.type` values mirrors the server's `classifyErrorAction` table; key ones:

| `type` | `retryable` | `recommendation` | When |
|--------|-------------|------------------|------|
| `rate_limited` | true | `wait` | 429 with `Retry-After` |
| `timeout` | true | `retry` | upstream slow |
| `server_error` | true | `retry` | 5xx |
| `auth_error` | false | `reauth` | 401 / 403 |
| `validation_error` | false | `abort` | bad request body |
| `circuit_open` | false | `wait` | per-model breaker tripped |
| `guard_exhausted` | false | `abort` | output-guard gave up |

## Rate limits

Server enforces per-key and per-connector rate limits. On a 429 the SDK exposes the `Retry-After` value:

```ts
if (err instanceof ConnectorError && err.status === 429 && err.retryAfter) {
  await new Promise(r => setTimeout(r, err.retryAfter * 1000));
}
```

## Test injection

For unit tests, inject a `fetch` implementation (e.g. msw v2, undici `MockAgent`):

```ts
import { Client } from '@arcanada/model-connector-sdk';

const fakeFetch: typeof fetch = async (_url, _init) =>
  new Response(JSON.stringify({ id: 'x', /* ... */ }), { status: 201 });

const client = new Client({ apiKey: 'test', fetch: fakeFetch });
```

## See also

- [Python SDK](./sdk-python.md)
- [Architecture overview](./architecture.md)
- [Capability matrix](./capability-matrix.md)

---

**Жизнь одного человека имеет значение / One human life matters**
