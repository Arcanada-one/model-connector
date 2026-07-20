# How-to: Python SDK (`arcanada-model-connector`)

This guide walks a Python consumer through every supported workflow against `connector.arcanada.ai`.

## Install

```bash
pip install arcanada-model-connector
```

Requirements: Python **>= 3.10**. Runtime deps: `httpx >= 0.27`, `pydantic >= 2.9`.

## Authenticate

```python
from arcanada_model_connector import Client

client = Client(
    api_key="arc_api_...",
    # base_url="https://connector.arcanada.ai",  # default
    # timeout=120.0,                                # default
)
```

The SDK redacts `Bearer ...` substrings and any `authorization` headers from `exc.cause` before raising, so logs stay clean.

## Execute a prompt (sync)

```python
response = client.execute({
    "connector": "openrouter",
    "model": "mistralai/mistral-small-3.2-24b-instruct",
    "prompt": "Summarise BGE-M3 retrieval characteristics in 40 words.",
})

print(response.result)
print(response.usage)        # ExecuteUsage(input_tokens=..., ...)
print(response.latency_ms)
```

Successful responses return **HTTP 201**; the SDK parses transparently.

## Execute a prompt (async)

```python
import asyncio
from arcanada_model_connector import AsyncClient

async def main() -> None:
    async with AsyncClient(api_key="arc_api_...") as client:
        response = await client.execute(
            {"connector": "openrouter", "prompt": "ping"}
        )
        print(response.result)

asyncio.run(main())
```

`Client` and `AsyncClient` share the exact same `ExecuteRequest` / `ExecuteResponse` types; only the await semantics differ.

## Structured output with `output_format` + `schema`

```python
response = client.execute({
    "connector": "openrouter",
    "prompt": "List 3 cities with population, return JSON.",
    "output_format": "json",
    "schema": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "population": {"type": "integer"},
            },
            "required": ["city", "population"],
        },
    },
})

print(response.repair_report)
# RepairReport(strategies_applied=['strip_fences'], retries=0,
#              final_valid=True, pass_='guarded')
print(response.structured)
```

`repair_report.pass_` semantics:

- `native` — provider returned valid output, no repair strategy applied.
- `guarded` — output-guard middleware repaired (fence stripping, trailing comma, etc.) and the final value is valid.
- `failed` — output-guard exhausted retries; the SDK raises `GuardExhaustedError`.

`output_format` accepts `json`, `yaml`, `toml`, `python`, or `auto`. `schema` is bounded by 32 KiB serialized-size (server-side).

## Error handling

```python
from arcanada_model_connector import (
    ConnectorError,
    GuardExhaustedError,
    TimeoutError,
)

try:
    response = client.execute({"connector": "openrouter", "prompt": "..."})
except GuardExhaustedError as exc:
    print("guard exhausted:", exc.envelope.message if exc.envelope else "")
except TimeoutError:
    print("timeout")
except ConnectorError as exc:
    print(f"http {exc.status}: {exc.envelope.type if exc.envelope else 'unknown'}")
    if exc.envelope and exc.envelope.retryable and exc.retry_after:
        # wait exc.retry_after seconds before retrying
        ...
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

```python
import time

try:
    response = client.execute({"connector": "openrouter", "prompt": "..."})
except ConnectorError as exc:
    if exc.status == 429 and exc.retry_after:
        time.sleep(exc.retry_after)
```

## Test injection

For unit tests, supply an `httpx.MockTransport` via the `transport=` constructor arg:

```python
import httpx
from arcanada_model_connector import Client

def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(201, json={"id": "x", "status": "success", ...})

client = Client(api_key="test", transport=httpx.MockTransport(handler))
```

## See also

- [TypeScript SDK](./sdk-typescript.md)
- [Architecture overview](./architecture.md)
- [Capability matrix](./capability-matrix.md)

---

**Жизнь одного человека имеет значение / One human life matters**
