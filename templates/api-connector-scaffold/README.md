# API Connector Scaffold

Static template для нового OpenAI-compat API connector. Извлечён из 3 живых connectors (OpenRouter, Groq, Grok) — verbatim ~55 LoC of ~110 совпадает между всеми тремя.

**Цель:** time-to-implement нового OpenAI-compat connector ≤ 30 min wall-clock.

**Origin:** CONN-0049 (consolidates CONN-0047 reflection Proposal 2 + CONN-0048 reflection Proposal 3).

## When to use

Apply this scaffold ТОЛЬКО для providers, которые соответствуют OpenAI Chat Completions wire format:

- `POST /v1/chat/completions` endpoint
- Request body `{model, messages: [{role, content}]}`
- Response body `{choices: [{message: {content}}], usage: {prompt_tokens, completion_tokens}}`
- Bearer auth header

Если provider использует другой wire format (Anthropic native, custom JSON, gRPC) — не подходит. Пиши connector с нуля.

## Step 0 — capture live fixture (CONN-0048 lesson)

Перед find-replace: убедись, что provider реально работает с твоим API key:

```bash
# Models endpoint — fast no-cost probe
curl -fsS "{{BASE_URL}}/v1/models" \
  -H "Authorization: Bearer $REAL_KEY" \
  | jq . > fixtures/{{NAME_LOWER}}-models.json

# One real chat completion — capture wire response для spec fixtures
curl -fsS "{{BASE_URL}}/v1/chat/completions" \
  -H "Authorization: Bearer $REAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"{{DEFAULT_MODEL}}","messages":[{"role":"user","content":"reply ok"}]}' \
  | jq . > fixtures/{{NAME_LOWER}}-chat.json
```

Используй `chat.json` для replace `chatResponse` constant в spec. Не угадывай поля (`x_groq`, `system_fingerprint`, `service_tier`, `total_cost` — provider-specific).

## Substitution table (9 placeholders)

| Placeholder | Type | Example (Grok) | Locus в template |
|-------------|------|----------------|------------------|
| `{{NAME}}` | PascalCase | `Grok` | class name, module name, ChatResponse interface |
| `{{NAME_LOWER}}` | lowercase | `grok` | `readonly name`, module field, file names |
| `{{ENV_KEY_PREFIX}}` | UPPERCASE | `XAI` (note: divergent from NAME) | env-var prefix в `env.schema.ts` |
| `{{BASE_URL}}` | URL string | `https://api.x.ai` | `getBaseUrl()` return |
| `{{DEFAULT_MODEL}}` | string | `grok-4-fast` | `DEFAULT_MODEL` const |
| `{{MODELS_LIST}}` | string[] literal | `['grok-4-fast', 'grok-3', ...]` | `getCapabilities().models` |
| `{{API_KEY_ENV}}` | env var name | `XAI_API_KEY` | header line — note: НЕ всегда `${ENV_KEY_PREFIX}_API_KEY` |
| `{{TIMEOUT_ENV}}` | env var name | `GROK_TIMEOUT_MS` | timeout line |
| `{{COST_FIELD}}` | TS expression | `0` (Groq/Grok) или `json.usage?.total_cost ?? 0` (OpenRouter) | parseResponse `costUsd` |

**Watch-out:** `{{ENV_KEY_PREFIX}}` ≠ `{{NAME}}.toUpperCase()` всегда. Grok → `XAI_API_KEY` (xAI brand). OpenRouter → `OPENROUTER_API_KEY` (matches). Always cross-check provider docs.

## Post-generation checklist

- [ ] `cp -r templates/api-connector-scaffold src/connectors/{{NAME_LOWER}}` (target src tree)
- [ ] Rename files: `{{name}}.connector.ts` → `{{NAME_LOWER}}.connector.ts` (and `.module.ts`, `.connector.spec.ts`)
- [ ] Find-replace 9 placeholders в IDE (multi-cursor: search `\{\{[A-Z_]+\}\}` regex)
- [ ] Add to `src/connectors/connectors.module.ts` imports (mirror existing `GrokModule` pattern)
- [ ] Add 3 env vars в `src/config/env.schema.ts`:
  - `{{ENV_KEY_PREFIX}}_API_KEY: z.string().optional()` (or `.min(1)` if mandatory)
  - `{{TIMEOUT_ENV}}: z.coerce.number().min(5_000).max(600_000).default(120_000)` (optional если default 120s OK)
  - `{{ENV_KEY_PREFIX}}_MAX_CONCURRENCY: z.coerce.number().min(1).max(20).default(10)`
- [ ] Add `.env.example` entries для 3 vars
- [ ] Replace `chatResponse` fixture в spec с captured payload (Step 0)
- [ ] Replace `'replace-me-alt-model'` в spec с реальной 2-й моделью из `{{MODELS_LIST}}`
- [ ] `pnpm build && pnpm test -- src/connectors/{{NAME_LOWER}}/` — verify ≥18 specs pass
- [ ] `pnpm lint` — 0 warnings

## Divergences NOT covered by template

Эти случаи ожидают manual override после copy:

| Divergence | Pattern | Example |
|------------|---------|---------|
| Cost field | `costUsd: <expr>` | OpenRouter — `json.usage?.total_cost ?? 0`; default — `0` |
| Endpoint path prefix | `buildRequestUrl()` body | Groq использует `/openai/v1/chat/completions`, не `/v1/chat/completions` (extra `/openai` segment); manually fix string |
| Provider-specific extras в response | spec fixture | `system_fingerprint`, `x_groq`, `service_tier` — drop из template, добавь if real |
| Error envelope quirks | `BaseApiConnector.classifyHttpError()` | xAI returns 400 not 401 для invalid keys — обрабатывается в base, может потребоваться spec adjust |

## Drift watch (for maintainers of base classes)

При изменении `src/connectors/base-api.connector.ts` или `src/connectors/interfaces/connector.interface.ts` — sync template:

1. Diff `src/connectors/grok/grok.connector.ts` vs `templates/api-connector-scaffold/{{name}}.connector.ts` (modulo placeholders).
2. Если расхождение появилось — обнови template к новому base contract.
3. Reminder упомянут в `Projects/Model Connector/CLAUDE.md` § "Adding a new OpenAI-compat connector".

## What this template does NOT include

- Streaming (SSE) — `supportsStreaming: false` hardcoded
- `json_schema` structured output — providers без поддержки используют `json_object` через prompt injection
- Tool calling — declared `supportsTools: true` but actual implementation outside scope (none of 3 reference connectors implement tool execution)
- Custom error envelope parsing — relies on `BaseApiConnector.classifyHttpError()`
- Cost calculation logic — providers без `total_cost` в usage остаются `costUsd: 0` (downstream metrics fix отдельно)
