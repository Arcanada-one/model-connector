# @arcanada/model-connector-sdk

[![npm](https://img.shields.io/npm/v/@arcanada/model-connector-sdk.svg)](https://www.npmjs.com/package/@arcanada/model-connector-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Arcanada-one/model-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/Arcanada-one/model-connector/actions)
[![Node](https://img.shields.io/node/v/@arcanada/model-connector-sdk.svg)](https://nodejs.org)

Typed TypeScript client SDK for the **Arcanada Model Connector** — a unified API for AI CLI agents (Claude Code, Cursor, Gemini, Codex) and cloud model providers (OpenRouter, Groq, Grok, embedding services).

```bash
pnpm add @arcanada/model-connector-sdk
# or: npm install @arcanada/model-connector-sdk
# or: yarn add @arcanada/model-connector-sdk
```

## Quick start

```ts
import { Client } from '@arcanada/model-connector-sdk';

const client = new Client({ apiKey: process.env.ARC_API_KEY! });

const response = await client.execute({
  connector: 'openrouter',
  prompt: 'Explain BGE-M3 in 30 words.',
  model: 'mistralai/mistral-small-3.2-24b-instruct',
});

console.log(response.result);
```

### Structured output with `output_format` + `schema`

```ts
const response = await client.execute({
  connector: 'openrouter',
  prompt: "Return a JSON object with keys 'city' and 'population'.",
  output_format: 'json',
  schema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      population: { type: 'integer' },
    },
    required: ['city', 'population'],
  },
});

console.log(response.repair_report);
console.log(response.structured);
```

`repair_report.pass` is one of:

- `native` — provider returned valid output, no repair needed.
- `guarded` — output-guard middleware applied repair strategies successfully.
- `failed` — output-guard exhausted retries; thrown as `GuardExhaustedError`.

## Error handling

```ts
import { ConnectorError, GuardExhaustedError, TimeoutError } from '@arcanada/model-connector-sdk';

try {
  const response = await client.execute({ connector: 'openrouter', prompt: '...' });
} catch (err) {
  if (err instanceof GuardExhaustedError) {
    console.error('guard exhausted:', err.envelope?.message);
  } else if (err instanceof ConnectorError) {
    console.error(`HTTP ${err.status}: ${err.envelope?.type}`);
    if (err.retryAfter) console.error(`retry after ${err.retryAfter}s`);
  } else if (err instanceof TimeoutError) {
    console.error('timed out');
  }
}
```

The SDK redacts `Authorization` headers and `Bearer` tokens from `err.cause` before throwing.

## Requirements

- Node.js >= 20 (global `fetch` is used out of the box)
- No runtime dependencies

## Documentation

- [TypeScript SDK how-to](https://github.com/Arcanada-one/model-connector/blob/main/docs/sdk-typescript.md)
- [Model Connector overview](https://github.com/Arcanada-one/model-connector#readme)
- [Capability matrix](https://github.com/Arcanada-one/model-connector/blob/main/docs/capability-matrix.md)

## License

MIT © Arcanada

---

**Жизнь одного человека имеет значение / One human life matters**
