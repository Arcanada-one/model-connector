# How to Use the Low-Reasoning Cascade Profile

This guide explains how to route requests through the low-cost cascade using the
`low-reasoning` profile (CONN-0223).

## When to Use

Use `profile: "low-reasoning"` when:

- The task does not require advanced reasoning (classification, extraction, simple Q&A).
- You want automatic fallback across free-tier models with optional paid fallback.
- You want cost efficiency without manually selecting a connector.

## Usage

```http
POST /execute
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "profile": "low-reasoning",
  "prompt": "Classify this text as positive or negative: Great product!"
}
```

Note: `profile` and `connector` are mutually exclusive — provide exactly one.

## Cascade Order

The default cascade order (`CASCADE_LOW_REASONING_ORDER`) tries candidates in order:

1. `openmodel:deepseek-v4-flash` (free)
2. `openrouter:meta-llama/llama-4-maverick` (free)
3. `openrouter:deepseek-v4-flash` (paid, only when `CASCADE_PAID_ENABLED=true`)

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `CASCADE_LOW_REASONING_ORDER` | see above | Ordered cascade candidates (`connector:model:tier` CSV). |
| `CASCADE_PAID_ENABLED` | `false` | Allow fallback to paid candidates. |
| `CASCADE_PAID_DAILY_BUDGET_USD` | `0.17` | Daily budget cap for paid tier (USD). |
| `CASCADE_PAID_MODEL` | `deepseek-v4-flash` | Default paid model identifier. |

## Error Handling

| Error | HTTP Status | Meaning |
|---|---|---|
| `cascade_exhausted` | 503 | All candidates failed or were unavailable. |
| `budget_exceeded` | 503 | Daily paid budget reached before paid tier was attempted. |

## Security Note

The cascade module (`src/connectors/cascade/`) contains no direct HTTP calls.
All network I/O is delegated to `ConnectorsService`, which enforces auth, retries,
circuit breakers, and metrics recording.
