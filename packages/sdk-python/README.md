# arcanada-model-connector

[![PyPI](https://img.shields.io/pypi/v/arcanada-model-connector.svg)](https://pypi.org/project/arcanada-model-connector/)
[![Python](https://img.shields.io/pypi/pyversions/arcanada-model-connector.svg)](https://pypi.org/project/arcanada-model-connector/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)

Typed Python client SDK for the **Arcanada Model Connector** — a unified API for AI CLI agents (Claude Code, Cursor, Gemini, Codex) and cloud model providers (OpenRouter, Groq, Grok, embedding services).

```bash
pip install arcanada-model-connector
```

## Quick start

```python
from arcanada_model_connector import Client

client = Client(api_key="arc_api_...")
response = client.execute({
    "connector": "openrouter",
    "prompt": "Explain BGE-M3 in 30 words.",
    "model": "mistralai/mistral-small-3.2-24b-instruct",
})
print(response.result)
```

### Async

```python
import asyncio
from arcanada_model_connector import AsyncClient

async def main() -> None:
    async with AsyncClient(api_key="arc_api_...") as client:
        response = await client.execute({"connector": "openrouter", "prompt": "ping"})
        print(response.result)

asyncio.run(main())
```

### Structured output with `output_format` + `schema`

```python
response = client.execute({
    "connector": "openrouter",
    "prompt": "Return a JSON object with keys 'city' and 'population'.",
    "output_format": "json",
    "schema": {
        "type": "object",
        "properties": {
            "city": {"type": "string"},
            "population": {"type": "integer"},
        },
        "required": ["city", "population"],
    },
})
print(response.repair_report)  # native | guarded | failed
print(response.structured)
```

`repair_report.pass_` is one of:

- `native` — provider returned valid output, no repair needed.
- `guarded` — output-guard middleware applied repair strategies successfully.
- `failed` — output-guard exhausted retries; raised as `GuardExhaustedError`.

## Error handling

```python
from arcanada_model_connector import ConnectorError, GuardExhaustedError, TimeoutError

try:
    response = client.execute({"connector": "openrouter", "prompt": "..."})
except GuardExhaustedError as exc:
    print("guard exhausted:", exc.envelope.message)
except ConnectorError as exc:
    print(f"HTTP {exc.status}: {exc.envelope.type if exc.envelope else 'unknown'}")
    if exc.retry_after:
        print(f"retry after {exc.retry_after}s")
except TimeoutError as exc:
    print("timed out after", exc.timeout, "seconds")
```

The SDK redacts `Authorization` headers and `Bearer` tokens from `exc.cause` before raising, so safe to log.

## Documentation

- [Python SDK how-to](https://github.com/Arcanada-one/model-connector/blob/main/docs/sdk-python.md)
- [Model Connector overview](https://github.com/Arcanada-one/model-connector#readme)
- [Capability matrix](https://github.com/Arcanada-one/model-connector/blob/main/docs/capability-matrix.md)

## License

MIT © Arcanada

---

**Жизнь одного человека имеет значение / One human life matters**
