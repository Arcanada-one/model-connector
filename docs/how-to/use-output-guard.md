# How to: use `output_format` with `/execute`

Opt-in structured-output validate-and-repair middleware.

## What you get

When you POST `/execute` with `output_format`, Model Connector:

1. Routes the request through a per-provider schema injector (provider-native
   structured output where available — OpenRouter, OpenAI, Anthropic, Gemini —
   prompt-only fallback for CLI connectors).
2. Validates the connector's `result` text against the supplied JSON Schema
   via the [`@arcanada/output-guard`][lib] library.
3. Repairs common malformed-output failure modes (markdown fences, trailing
   commas, Python booleans, truncated JSON, etc.) with up to
   `OUTPUT_GUARD_MAX_RETRIES` retry rounds.
4. Returns the parsed value on `response.structured` plus a `repair_report`
   envelope so the caller can audit retries and applied strategies.

[lib]: https://github.com/Arcanada-one/output-guard

## Request fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output_format` | `"json" \| "yaml" \| "toml" \| "python" \| "auto"` | yes (opt-in) | Format to validate. `auto` detects from response heuristics. Absence ⇒ guard bypassed. |
| `schema` | JSON Schema object | optional | Validated via ajv (formats enabled). ≤32 KiB after `JSON.stringify`. |

Existing fields (`connector`, `prompt`, `model`, `systemPrompt`, `extra`, …)
work unchanged. `responseFormat: { type: "json_object" }` (legacy
path) is bypassed when `output_format` is present.

## Response envelope

When `output_format` is set, the response gains:

| Field | Type | Description |
|-------|------|-------------|
| `repair_report.strategies_applied` | `string[]` | Library strategies that fired (`strip-fences`, `fix-commas`, …). Empty on raw-clean. |
| `repair_report.retries` | `number` | Outer retry rounds consumed. `0` on first-attempt success. |
| `repair_report.final_valid` | `boolean` | True iff parsed + schema-validated successfully. |
| `repair_report.pass` | `"native" \| "guarded" \| "failed"` | `native` = first attempt, no strategies, supportsJsonSchema connector. `guarded` = library repaired. `failed` = `MAX_RETRIES` exhausted. |
| `repair_report.error` | `string?` | Last error when `final_valid=false`. |
| `structured` | `unknown` | Parsed/repaired value (populated only when `final_valid=true`). |

On `pass === 'failed'` the response is shaped as an error:

```json
{
  "status": "error",
  "error": { "type": "guard_exhausted", "retryable": false, "recommendation": "abort" },
  "repair_report": { "pass": "failed", "final_valid": false, "retries": 3, ... }
}
```

`guard_exhausted` is intentionally **not** in `RETRYABLE_ERRORS` — the
outer `ConnectorsService` retry loop will not double-retry on top of the
middleware's retry budget.

## Example: curl

```bash
curl -sS -X POST "https://connector.arcanada.one/execute" \
  -H "Authorization: Bearer ${MC_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "connector": "openrouter",
    "model": "inclusionai/ling-2.6-flash:free",
    "prompt": "Respond ONLY with JSON {\"name\":\"test\",\"value\":42} wrapped in markdown fences.",
    "output_format": "json",
    "schema": {
      "type": "object",
      "properties": {"name": {"type": "string"}, "value": {"type": "number"}},
      "required": ["name", "value"]
    }
  }' | jq '.repair_report'
```

Typical response:

```json
{
  "strategies_applied": ["strip-fences"],
  "retries": 0,
  "final_valid": true,
  "pass": "guarded"
}
```

## Environment variables

| Variable | Default | Range | Effect |
|----------|---------|-------|--------|
| `OUTPUT_GUARD_ENABLED` | `true` | bool | Kill-switch — `false` bypasses the middleware unconditionally. Use for incident rollback without redeploy. |
| `OUTPUT_GUARD_MAX_RETRIES` | `3` | 0..5 | Hard cap on guard retry rounds. The outer connector retry loop is independent and uses `CONNECTOR_MAX_RETRIES`. |
| `OUTPUT_GUARD_TIMEOUT_MS` | `30000` | 1000..120000 | Reserved for per-call AbortController timeout (forwarded to the library). |

## Backward compatibility

Requests omitting `output_format` are byte-identical to the pre-v0.2.0
contract — `repair_report` is absent, no DB column written.

## Rollback

Rollback strategy:

1. `OUTPUT_GUARD_ENABLED=false` in the container env, then `docker compose
   restart model-connector`.
2. Hot revert: `git revert <merge-commit>` and let CI redeploy.
3. The nullable `repairReport` Prisma column is harmless if left in place.
