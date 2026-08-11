# How to Point an OpenAI Client at the Model Connector Failover Gateway

This guide shows how to route any OpenAI-shaped client through the Model Connector
(MC) so that, when your primary provider is rate-limited or over quota, MC transparently
fails over to a live, **free-first** provider (DeepSeek first) — without any client change
beyond the base URL and API key (CONN-0243).

## When to Use

Use the `/v1/chat/completions` gateway when:

- You have an OpenAI SDK / LiteLLM / Hermes custom-provider client and want resilience
  against a single provider's 429 / over-quota / 5xx without writing your own fallback.
- You want free providers preferred automatically (DeepSeek as the default first hop),
  with paid providers only as a configured last resort.

For explicit single-connector calls or the profile-based cascade, keep using
`POST /execute` (see [low-reasoning-cascade](./low-reasoning-cascade.md)).

## Configure the Client

Point `base_url` at the MC `/v1` surface and use your MC API key as the bearer token.

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://connector.arcanada.ai/v1",
    api_key="<YOUR_MC_API_KEY>",
)

resp = client.chat.completions.create(
    model="auto",                       # "auto" → pure free-first chain (DeepSeek first)
    messages=[
        {"role": "system", "content": "Be brief."},
        {"role": "user", "content": "Say hi."},
    ],
)
print(resp.choices[0].message.content)
```

### curl

```bash
curl https://connector.arcanada.ai/v1/chat/completions \
  -H "Authorization: Bearer $MC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Say hi."}]
  }'
```

## Choosing a Model

The `model` field is a **routing preference, not a hard constraint** — MC is a failover
gateway:

- `"auto"` / `"failover"` / `"free"` / an unknown id → the pure free-first chain
  (DeepSeek → other free providers). This is the recommended Hermes setting.
- A concrete catalog model (e.g. `"deepseek-v4-flash"`) → that model is tried first,
  then the free-first chain follows as fallback.
- A paid model with `FAILOVER_ALLOW_FREE_DOWNGRADE=false` → only that model is attempted
  (no silent downgrade to a free provider).

List the models MC currently serves:

```bash
curl https://connector.arcanada.ai/v1/models -H "Authorization: Bearer $MC_API_KEY"
```

## How Failover Works

1. MC builds an ordered candidate list from the registered connectors' capabilities
   (in-memory — no extra network probes), free-first, DeepSeek promoted to the front.
2. It calls the first candidate. On `429` / `5xx` / connection error / open circuit it
   advances to the next candidate transparently.
3. The first successful provider's completion is returned in OpenAI shape. If every
   candidate fails, MC returns `503` with a `cascade_exhausted` error body.

Each inner call uses a single attempt (no compounded backoff) so failover is fast.

## Tuning

Set these in the MC environment (see `.env.example`):

| Variable | Default | Effect |
|----------|---------|--------|
| `FAILOVER_PROVIDER_ORDER` | `openmodel,groq,openrouter,gemini` | Free-tier provider priority. |
| `FAILOVER_DEEPSEEK_MODEL` | `deepseek-v4-flash` | The DeepSeek default first free hop. |
| `FAILOVER_PAID_ENABLED` | `false` | Append paid candidates after all free ones. |
| `FAILOVER_ALLOW_FREE_DOWNGRADE` | `true` | Allow a failed/unknown requested model to fall back to free. |

## Limitations

- `stream: true` is rejected with `400` (streaming is a planned follow-up).
- `tools` / `tool_choice` are rejected with `400` (function calling is a planned follow-up).
- `finish_reason` is always `stop` for successful completions.

See the [/v1 surface reference](../reference/v1-openai-surface.md) for exact shapes.
