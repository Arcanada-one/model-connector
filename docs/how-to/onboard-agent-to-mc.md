# How to: Onboard a fleet agent to the Model Connector

Operator runbook for putting a new agent or service behind the Model Connector
so it holds **only** an MC access token — never a provider API key. This is the
end-to-end procedure; the policy *shape* is documented in the README
(§ Per-key access policy), the deploy pipeline in `deploy-runbook.md`.

> Mandate: agents hold only an MC access token; provider keys (OpenRouter,
> Groq, …) live only inside MC. A free-only agent must be **refused** on a paid
> model, never silently billed. New consumers must not carry `OPENROUTER_API_KEY`
> (or any provider key) in their own environment.

## Prerequisites

- `ADMIN_TOKEN` for the admin API (in the MC prod `.env`; header `x-admin-token`).
- The consumer's own repo/host does **not** already send a provider key. If it
  does, that call path is what you are replacing.

## 1. Decide the policy from the consumer's real need

Pick the narrowest policy that does not break the consumer:

| Consumer kind | Policy |
|---|---|
| Agent that only needs free models | `{"policyVersion":1,"models":{"mode":"free-only"}}` — **omit `providers`** so any free route works (OpenRouter *and* the free rungs of other gateways). Adding `"providers":["openrouter"]` restricts it to OpenRouter and will block a model the agent legitimately reaches through another connector. |
| Agent needing its own OpenRouter key + free-only | add `"providers":["openrouter"]` and `"providerKeys":{"openrouter":"<ENV_VAR_NAME>"}` (see step 3). |
| Consumer that legitimately needs specific paid models | `"models":{"mode":"list","list":["<exact model ids>"]}` — scope to the models it actually uses, derived from its request history, not `mode:"all"`. |
| User-facing / billed product (e.g. Verdicus) | Out of scope for free-only. Give an explicit `list` or leave unrestricted **by deliberate decision**, recorded — not by default. |

**`free-only` reads the tier from the model catalog** (`model_catalog`, real
tariffs), not the `:free` id suffix. A model whose catalog tier is `paid` or
`unknown` is **denied** under `free-only` (fail-closed). Before choosing
`free-only` for a live consumer, confirm every model it uses is catalog-free:

```bash
# on arcana-dbs, inside the postgres container
psql -U postgres -d arcanada_connector -tAc \
  "SELECT connector, model, free, tier FROM model_catalog WHERE model ILIKE '%<model>%';"
```

If the consumer relies on a catalog-`paid`/`unknown` model (e.g. anything via
the OpenModel gateway, which is a paid gateway with no free models), `free-only`
will break it — use a `list` policy or fix the catalog tier first.

## 2. Mint the token

```bash
curl -s -X POST http://127.0.0.1:3900/admin/keys \
  -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<consumer-name>","policy":{ ... }}'
# → {"id":"<uuid>","name":"...","key":"mc-<hex>"}   (key shown ONCE)
```

Store the returned `key` where the consumer reads its MC token (its own
`accounts.json` / deploy env), and record the `id`. Never paste the value into
a doc, log, or commit — path/name only.

To set or change a policy on an existing key:

```bash
curl -s -X PATCH http://127.0.0.1:3900/admin/keys/<id>/policy \
  -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"policy":{ ... }}'      # {"policy":null} clears it (back to unrestricted)
```

The change is live immediately (the choke-point policy cache is invalidated on
write); no MC restart needed.

## 3. (Optional) Give the token its own provider key via Vault

When the policy names `providerKeys`, MC injects a dedicated provider key for
that token instead of the shared one. The key value lives in Vault and reaches
MC's process env at boot — never on disk, never in a commit.

1. Store the key in Vault (operator, once): `arcanada/shared/tokens/<name>`,
   field `api_key`.
2. Add the path + target env var name to `SECRETS` in
   `scripts/vault-provider-keys.mjs` and the env var name to the policy's
   `providerKeys` (only `KEY_OVERRIDE_CAPABLE` connectors — currently
   `openrouter` — may appear here; write-time validation rejects others).
3. Ensure MC's deploy env carries the Vault AppRole (`MC_VAULT_ROLE_ID`,
   `MC_VAULT_SECRET_ID`, `VAULT_ADDR`). The AppRole needs a read-only policy on
   the token paths:

   ```bash
   # in the Vault container, with an admin token
   vault policy write model-connector-tokens - <<'POL'
   path "arcanada/data/shared/tokens/<name>" { capabilities = ["read"] }
   POL
   vault write auth/approle/role/model-connector token_policies=model-connector-tokens \
     token_ttl=20m token_max_ttl=40m
   ```

At boot the entrypoint runs `vault-provider-keys.mjs`: on partial config or an
unreadable secret it aborts with **exit 78** (a silently missing per-agent key
would route the agent through the shared key — forbidden). A missing env var
named by a policy fails a request with `config_error`, never a silent fallback.

## 4. Point the consumer at MC and drop its provider key

- Replace the consumer's direct provider call with MC's OpenAI-compatible
  endpoint `POST <MC_URL>/v1/chat/completions` (Bearer = the MC token), or the
  native `POST <MC_URL>/execute`. `MC_URL` is `https://connector.arcanada.ai`.
- Remove `OPENROUTER_API_KEY` (or any provider key) from the consumer's env and
  make it optional/unused in its config schema. The consumer must fail
  gracefully (not crash) when its MC token is absent.
- **Deploy-env trap**: several prod services (opsbot, muneral, legal-arcana,
  transcribator) do not read `/srv/apps/<svc>/.env` at runtime — they deploy via
  `arcanada-compose-broker` from `/var/lib/arcanada-deploy/<svc>`, whose `.env`
  is installed from the canonical `/etc/arcanada/deploy-env/<svc>.env` on every
  `sync`. Edit the **canonical** file, then
  `install -m0600 /etc/arcanada/deploy-env/<svc>.env /var/lib/arcanada-deploy/<svc>/.env`
  and `arcanada-compose-broker <svc> up`. Editing `/srv/apps/<svc>/.env` for
  such a service does nothing.

## 5. Verify live (not by green healthcheck)

```bash
K=<the-mc-token>
# free model → 201 success
curl -s -o /dev/null -w "free: %{http_code}\n" -X POST http://127.0.0.1:3900/execute \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"connector":"openrouter","model":"nvidia/nemotron-3-nano-30b-a3b:free","prompt":"hi","responseFormat":{"type":"json_object"}}'
# paid model on a free-only token → 403 policy_violation, costUsd 0
curl -s -o /dev/null -w "paid: %{http_code} (want 403)\n" -X POST http://127.0.0.1:3900/execute \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"connector":"openrouter","model":"openai/gpt-4o","prompt":"hi"}'
# GET /v1/models is filtered to what the token may use
curl -s http://127.0.0.1:3900/v1/models -H "Authorization: Bearer $K" | jq '.data | length'
```

For a `providerKeys` token, confirm the dedicated key is really used and there
is no shared-key fallback: point the policy's `providerKeys` env name at a
non-existent variable and confirm the request returns `config_error` (not a
silent 201), then restore.

Then verify the **actual consumer** end to end (send it a real unit of work and
watch it reach MC), because a green `/health` proves only that MC is up, not
that the consumer's token, env, and deploy path are wired.

## 6. Read-only showcase keys (CONN-1674)

Not every consumer is an *agent that executes*. A **showcase key** backs a
PUBLIC read-only surface — the arcanada.ai ecosystem page renders the full model
catalog by fetching `GET /connectors/catalog` (no `?free=true` — it asks for
**everything**) with the `arcanada-landing-catalog` key. Such a key never calls
`/execute`, so widening its visibility grants no execution rights; conversely,
**any narrowing of its policy silently collapses the public page**. That is
exactly what happened on 2026-08-12 (CONN-1669): a `{"models":{"mode":"free-only"}}`
policy on the showcase key cut the public catalog from **998 models / 26
providers to 33 / 3**, and nothing alarmed — an operator caught it by eye
(INFRA-0410/0412).

**Rule: a showcase key's policy must never restrict `providers` or set
`models.mode` to anything but `all`. Leave it unrestricted (clear the policy, or
`{"policyVersion":1}`).** Two guards enforce this (CONN-1674):

- **Write-time guard.** List every showcase key's id in the `SHOWCASE_KEY_IDS`
  env (CSV). `PATCH /admin/keys/:id/policy` then **rejects** (400) any narrowing
  policy on a listed key. This stops the common path (an admin API call).
- **Runtime alarm.** `getCatalog` warns (`CONN-1674 showcase catalog narrowed:
  …`) whenever a showcase key's policy still trims more than
  `SHOWCASE_CATALOG_NARROW_ALARM_PCT` (default 0.5) of the visible catalog. This
  is the layer that catches a narrowing applied **out of band** — e.g. a direct
  DB edit, which is how CONN-1669 actually landed and which the write-time guard
  cannot see. Wire the warn into the alerting sink so silence never reads as
  health.

### Consumer-key registry (purpose → expected visibility)

Keep this list current when onboarding a consumer, so a future policy change can
be checked against what each key is *for* before it ships:

| Key | Purpose | Policy | Expected visibility |
|---|---|---|---|
| `arcanada-landing-catalog` | **Read-only showcase** — public ecosystem catalog page (arcanada.ai). Never executes. | unrestricted (`{"policyVersion":1}`), in `SHOWCASE_KEY_IDS` | **Full catalog** (all providers, all tiers). Any narrowing is a defect. |
| `Email Agent` | Email Agent free-model pool; own OpenRouter key | `providers:["openrouter","groq"]`, `models.mode:"free-only"`, `providerKeys.openrouter` | Free models of openrouter + groq (gemini deliberately excluded) |
| Verdicus (user-facing) | Billed product | Out of scope for free-only — explicit `list` or deliberately unrestricted, **recorded** | Per its recorded policy |

When MC adds a free provider and an agent should use it, PATCH that agent's
policy to add the provider — the catalog read does **not** auto-expand across the
policy boundary (CONN-1665: discovery mirrors enforcement).
