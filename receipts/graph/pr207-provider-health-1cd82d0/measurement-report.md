# PR207 measurement at source head 1cd82d06

## Prompt-cache timing attribution

The `prompt-cache-policy.spec.ts` latency test was run ten times per tree in strict interleaved order (base, PR, repeated), sequentially under `nice -n 10`, on Node v24.20.0. The command was `nice -n 10 pnpm exec vitest run src/prompt-cache/prompt-cache-policy.spec.ts --reporter=verbose`. Each run executes 200 positive evaluations and checks their p95 against a 20 ms budget.

Base `bb70aae82e78678dfb4e8f13621582ae6bd8cf74`: 9/10 passed, 1/10 failed the timing assertion. Positive p95 ranged 2.114610–24.999546 ms; median 4.166716 ms.

PR `1cd82d06dafd12be32368750611538542ae14111`: 10/10 passed. Positive p95 ranged 2.830516–5.068388 ms; median 4.256314 ms.

Only the base exceeded 20 ms (24.999546 ms); PR did not. This does not support PR-caused slowdown. It identifies the wall-clock threshold test as load-sensitive baseline debt, tracked by Muneral task `14d5ee02-ecb8-4d76-a6cb-a69dd0beb8ca`. All per-run measurements and SHA-256 digests of the raw logs are in `prompt-cache-interleaved.json`; raw verbose logs remain in the durable task evidence directory.

A separate first interleaved series used Vitest JSON reporter: 10/10 passing on base and 10/10 passing on PR (16 tests per run). The JSON reporter suppressed the timing line, so that series is not used for p95 attribution.

## Full-suite comparison

The comparable isolated full-suite runs under `nice -n 10` showed three common failing specs: `src/billing/credit-gate.spec.ts`, `src/connectors/aborted-attempt-intent-path.spec.ts`, and `src/connectors/cascade/cascade.module.di.spec.ts`. Both full runs had three failing tests; candidate had eight failed suites and base had nine. The other failed suite differs: PR had `src/prompt-cache/prompt-cache-policy.spec.ts`, while base had `src/connectors/base-cli.connector.spec.ts`. The focused interleaved experiment above shows the PR does not slow the prompt-cache policy timing path; the full-suite observation is consistent with load sensitivity, not evidence for a PR regression. The shared failures are tracked by Muneral `14d5ee02-ecb8-4d76-a6cb-a69dd0beb8ca`.

## Route canary at the candidate source

`result.json` is a candidate-local `CanaryResult/v1`, captured at source commit `1cd82d06dafd12be32368750611538542ae14111` and tree `0c1906882d8085c6dfc6e9820d9d2af99016be46`. The run exercised 35 routes with 70 requests; 66 were verified and four remain honestly failed. `/health/ready` was polled to HTTP 200 before sampling. No real upstream provider was called.

Two chat/intents routes returned 503 `strict_chat_unavailable` on both candidate and exact base, same status/body; they are bound to task `709559c4-2ff7-4e2a-a69e-3b5de1dd2ce7`. Both STT routes returned HTTP 500 `FST_INVALID_MULTIPART_CONTENT_TYPE` on both candidate and exact base; they are bound to `cb07a5b3-0bc0-46b1-a3d7-9de4e9d60f86`. These are tracked baseline exemptions, not passes, and the result rows remain failed. Details and expiry are in `route-baseline-exemptions.json`.

## Hosted CI boundary

At measurement time GitHub PR #207 still pointed to `8232c029f0b708dc893afa7908bcb21e7a54ac4d`, not the measured local source head `1cd82d06dafd12be32368750611538542ae14111`. The hosted `lint-and-test` check for `8232c029` failed two `test/bench-reservation/boundary-http.spec.ts` assertions because `/health` and `/health/ready` returned HTTP 500 rather than expected 200; `docker-e2e` and deploy were skipped. This is not a CI verdict for `1cd82d0`.
