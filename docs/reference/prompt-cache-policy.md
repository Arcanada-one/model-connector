# Prompt-cache policy (Prompt Layout Contract v1 at the gateway)

Model Connector enforces the Arcanada **Prompt Layout Contract v1** for cache-aware agents
(program epic AUP-E28, portion AUP-CACHE-006 `enforce0`). The contract lives in the
program repository (`contracts/prompt-cache/prompt-layout.v1.json`); the gateway carries a
**vendored, digest-pinned copy** and imports its rules — the model table, the scan patterns,
the violation codes with their severities — instead of restating them.

| Item | Value |
|---|---|
| Vendored copy | `src/prompt-cache/contract/prompt-layout.v1.json` |
| Pinned digest | `sha256:678dfa2e9e6c0493a51b432a6be09edabc06fa15e4f423c518f1c1e629c6e06a` (`PROMPT_LAYOUT_CONTRACT_SHA256`) |
| Loader | `loadPromptLayoutContract()` — digest → JSON → shape; a malformed or edited copy is a **boot failure**, never a fallback |
| Evaluator | `evaluatePromptCachePolicy()` — pure; parity of `prefix_hash` with the program's `prefix_lint.py` is asserted on the replay fixture |
| Hook | `AnthropicConnector.execute()` — the body as it will be sent is evaluated before the upstream call |
| Tenant | the calling API key id, from `ConnectorsService.execute()` via `promptCacheContext` — never from the request |

## Modes

`PROMPT_CACHE_POLICY_MODE` = `off` | `observe` (default) | `enforce`.

| Mode | What happens to a cache-claiming request |
|---|---|
| `off` | not evaluated |
| `observe` | evaluated; findings attached to the response (`promptCachePolicy`) and emitted as an event; **nothing is refused** |
| `enforce` | a `VIOLATION` is refused with a typed `policy_violation` error (HTTP 403) whose `details` is the decision |

The finding is identical in both modes; the mode decides only the action. `UNDETERMINED`
(unknown model, unreadable body) is a third verdict: marked in both modes, refused in
neither. A request that claims no caching at all (no `cache_control`, no claimed
`prefix_hash`) is `NOT_CLAIMED` and passes without a policy field — legacy responses keep
their byte-identical shape.

### Switching with a receipt (reversible)

```
POST /admin/prompt-cache/policy/mode      x-admin-token: …
{ "mode": "enforce", "actor": "conn-owner", "reason": "fixture matrix green on 2026-09-05" }
```

returns a `PolicyModeSwitchReceipt/v1`:

```json
{
  "schema": "PolicyModeSwitchReceipt/v1",
  "receipt_id": "…", "ts": "…", "gateway": "model-connector",
  "from": "observe", "to": "enforce", "changed": true,
  "actor": "conn-owner", "reason": "…",
  "contract_digest": "sha256:678dfa2e…",
  "reversible": true, "revert": { "mode": "observe" },
  "persistence": "process memory; a restart returns to the PROMPT_CACHE_POLICY_MODE boot default"
}
```

`GET /admin/prompt-cache/policy` shows the mode, the boot mode, the contract digest and the
receipts; `GET /admin/prompt-cache/events?limit=` the recent typed events. Reverting is the
same call with `revert.mode`. A switch without an actor or a reason is refused.

## How a cache-aware agent sends a request

`ConnectorRequest` flattens `system` to a string and knows one user message, so no
breakpoint could be placed through it (every request through the gateway used to be
`SYSTEM_NOT_BLOCKS` by construction). A cache-aware agent hands the Anthropic connector the
Messages API fields verbatim:

```json
{
  "connector": "anthropic",
  "prompt": "[replay step]",
  "model": "claude-fable-5-1",
  "extra": {
    "max_tokens": 1024,
    "messages_api": { "tools": [...], "system": [...blocks with cache_control...], "messages": [...] },
    "prompt_cache": { "session_id": "…", "session_epoch": "1", "prefix_hash": "sha256:…" }
  }
}
```

`messages_api` accepts exactly the allow-listed keys (`tools`, `tool_choice`, `system`,
`messages`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `metadata`, `thinking`,
`output_config`, `service_tier`); any other key is a `validation_error`, never dropped.
`prompt_cache.session_id` scopes the session rules; `session_epoch` is the **explicit**
declaration that the prefix changes (a new baseline) — without it, a changed tool set /
system / model / L3 inside the session is a violation. `prefix_hash` is the builder's own
hash; a mismatch with the bytes is held as `PREFIX_HASH_CONFLICT`, not resolved.

`prompt` remains CONN's own record of the request (logging, the pre-dispatch cost estimate);
the provider body comes from `messages_api`.

## Rules evaluated at the gateway

Contract (request scope): `SYSTEM_NOT_BLOCKS`, `MISSING_BREAKPOINT`, `BREAKPOINT_EXCESS`,
`BREAKPOINT_MISPLACED`, `L4_BREAKPOINT_NOT_LAST`, `TTL_INVALID`, `TTL_ORDER`,
`PREFIX_BELOW_MINIMUM` (the model's minimum cacheable prefix, when caching is claimed),
`MODEL_UNKNOWN`, `NON_TEXT_IN_PREFIX`, `TOOL_DUPLICATE`, and every scan pattern of the
contract before the last breakpoint (`SECRET_IN_PREFIX` — refusal severity —,
`TENANT_IN_PREFIX`, `USER_IDENTITY_IN_PREFIX`, `SESSION_ID_IN_PREFIX`, `DYN_*`,
`FEATURE_FLAG_IN_PREFIX`); `SECRET_IN_TAIL` after it (warning).

Contract (session scope): `SESSION_MODEL_CHANGED`, `SESSION_TOOLS_CHANGED`,
`TOOL_ORDER_NONDETERMINISTIC`, `SESSION_SYSTEM_CHANGED`, `SESSION_L3_CHANGED`,
`L4_NOT_APPEND_ONLY`, `PARAMS_CHANGED` (warning); `prefix_changed` + `changed_layers` on
every decision.

Gateway (tenant-scoped cache identity): `CROSS_TENANT_PREFIX` (a prefix first cached under
another API key), `SESSION_TENANT_MISMATCH` (a session id owned by another API key —
refusal severity), `PREFIX_HASH_CONFLICT`, `TENANT_UNATTRIBUTED`, `REQUEST_UNREADABLE`.
`cache_identity = sha256(tenant + prefix_hash)` on every decision.

**Not evaluated here** (reported in every decision as `not_evaluated`, never silently
skipped): `L3_GRAMMAR`, `L3_KEY_NOT_ALLOWED`, and `DYN_UUID` inside L3 — the L3 grammar is a
harness-side rule (`@arcanada/prompt-cache`, AUP-CACHE-005).

## Pre-warm

```
POST /v1/prompt-cache/prewarm      Authorization: Bearer <MC key>
{ "model": "claude-fable-5-1", "messages_api": { …the stable prefix… }, "prompt_cache": { "session_id": "…" } }
```

sends the prefix with `max_tokens: 0` (a permitted cache write / TTL refresh) through the
**same** `ConnectorsService.execute()` choke point — same policy, same billing, same
breakers — so a pre-warm can never bypass what a real step could not pass. Only the
Anthropic connector is accepted in `enforce0`.

## Typed events (Ops Bot design)

Every decision on a cache-claiming request, every mode switch and the contract load emit a
`PromptCachePolicyEvent/v1`. The default sink is the structured logger (one JSON line; `warn`
level for `mark`/`refuse`); a transport to Ops Bot is a later sink implementing
`PolicyEventSink` — a change of transport, not of shape. Events carry codes, layers and
hashes and **never request text** (a secret hit names the pattern index only).

```json
{
  "schema": "PromptCachePolicyEvent/v1",
  "event": "decision",
  "ts": "2026-09-05T08:00:00.000Z",
  "gateway": "model-connector",
  "mode": "enforce",
  "contract_digest": "sha256:678dfa2e…",
  "decision": {
    "decision_id": "…",
    "tenant": "<api key id>",
    "session_id": "…", "session_epoch": "1",
    "model": "claude-fable-5-1",
    "verdict": "VIOLATION", "action": "refuse",
    "codes": [{ "code": "SECRET_IN_PREFIX", "severity": "refusal", "layer": "L2" }],
    "prefix_hash": "sha256:…", "cache_identity": "sha256:…",
    "prefix_changed": false, "prewarm": false,
    "evaluated_ms": 0.4
  }
}
```

`event: "mode_switched"` carries the `receipt`; `event: "contract_loaded"` the digest.
Suggested Ops Bot rendering: one line per refusal (tenant, session, codes), an hourly count
of marks per code per tenant while in `observe`, and every mode switch verbatim.

## What the gateway never does

It never rewrites, trims, re-orders or "fixes" a request: the only outcomes are pass, mark
(sent unchanged, findings attached) and refuse (nothing sent). The rules are read from the
vendored contract; a rule that is not in the contract is a gateway rule and says so
(`source: "gateway"`).
