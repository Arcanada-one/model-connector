# Live smoke: typesafe-jev through Model Connector (CONN-JEV-04)

Prove the **direct** execute path `POST /connectors/typesafe-jev/execute` on a
deployed Model Connector build. This is not a fixture or a transport double: the
harness calls the live HTTP surface and judges the response against the product
gates (HTTP 201, observed decision, ledger-mirrored `usage.costUsd` /
`costSource`, A2-223 zero-cost negative control).

## Prerequisites

1. Deployed MC with `JEV_ENABLED=true`, a non-empty `TYPESAFE_API_KEY` (or a
   per-key override listed in `KEY_OVERRIDE_CAPABLE`), and
   `TYPESAFE_JEV_DISABLED` unset/false. See
   [enable-jev-shadow-decisions.md](./enable-jev-shadow-decisions.md).
2. Caller API key with USE access for `typesafe-jev` / `jev-latest`. A free-only
   policy cannot use an unpriced model.
3. Environment variable `MC_KEY` set to that caller key. Do not put the key in
   argv, source, logs or receipts.

## Run

```bash
export MC_KEY='…'   # never commit; never print
nice -n 10 node scripts/smoke-typesafe-jev.mjs \
  --base-url https://connector.arcanada.ai \
  --receipt receipts/mc/conn-jev-04-live.json
```

Optional: `MC_BASE_URL` overrides the default base when `--base-url` is omitted.

## Verdicts and exit codes

| Exit | Meaning |
|------|---------|
| 0 | `PASS` — 201 + `status=success` + `structured.status=observed` + `usage.costUsd` present; paid/`unpriced` zeros fail |
| 1 | `FAIL` — HTTP/body/cost negative control |
| 2 | Bad args |
| 10 | `NOT_MEASURED` — `MC_KEY` absent (fail-closed; execute not attempted) |
| 11 | `NOT_MEASURED` — network/parse probe error |

`NOT_MEASURED` is never reported as PASS. Missing credentials do not invent a
live success.

## What the judge checks

- HTTP status is **201** (Nest default for successful POST on this route).
- Body `status` is `success` (a typed pre-network refusal may still arrive as
  HTTP 201 with `status=error` — that is FAIL, not PASS).
- `structured.status` is `observed`.
- `usage.costUsd` is present and finite (mirrors `Request.costUsd` written in
  the same settle transaction).
- A2-223 negative control: `costSource` in `{provider,catalog}` with
  `costUsd===0` → FAIL. Successful `costSource=unpriced` with `costUsd===0` is
  also FAIL (served without a known price — same defect class).
- Explicit `catalog-free` with `costUsd===0` is allowed.

Receipts under `receipts/mc/` keep only redacted body fields (ids, usage,
structured provenance, error codes). Secret values are never written.

## Offline unit tests

```bash
nice -n 10 corepack pnpm@10.30.3 exec vitest run scripts/smoke-typesafe-jev.spec.mjs
```

These tests exercise `judge` / `parseArgs` / prompt shape only. They do **not**
establish provider availability or production pricing.
