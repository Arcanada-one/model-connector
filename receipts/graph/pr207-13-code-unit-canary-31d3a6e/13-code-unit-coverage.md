# PR #207: exact-source coverage for the 13 app/source code units

- Candidate: `31d3a6e3e008acc446af1c2440a8d1a51fc392b5`; base control: `bb70aae82e78678dfb4e8f13621582ae6bd8cf74`.
- The authenticated route sweep covers 35 routes with 70 HTTP probes per revision (authorized and unauthenticated controls). All 13 code units have a mapped route, and each authenticated mapped probe names both its route entity and `code_unit:` entity.
- Focused process canaries ran an exact test process for each of the 13 code units on candidate and base; both CanaryResult/v2 files show 13/13 verified. Base is the negative control.
- Runs used isolated PostgreSQL/Redis, throwaway client/admin credentials, fake provider credentials, loopback-only egress blocking and isolated HOME/XDG. No live provider was called.
- Expected provider-unavailable 503s and the no-fixture STT-job 404 retain their observed statuses and are `not_measured`, never pass or fail. Every HTTP 500 remains failed.

| Code unit | Mapped authenticated route | Candidate route result | Base route control | Focused process candidate/base | Decision |
|---|---|---|---|---|---|
| `src/admin/admin.controller.ts` | `POST /admin/keys` | HTTP 400 — verified | HTTP 400 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/admin/admin.controller.spec.ts`. |
| `src/admin/circuit-breaker.controller.ts` | `POST /admin/circuit-breaker/reset` | HTTP 200 — verified | HTTP 200 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/admin/circuit-breaker.controller.spec.ts`. |
| `src/admin/watcher-repair.controller.ts` | `POST /internal/watcher/circuit-breaker/reset` | HTTP 400 — verified | HTTP 400 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/admin/watcher-repair.controller.spec.ts`. |
| `src/billing/credits.controller.ts` | `GET /admin/credits/:apiKeyId` | HTTP 200 — verified | HTTP 200 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/billing/credits.controller.spec.ts`. |
| `src/connectors/cascade/cascade-router.service.ts` | `POST /connectors/:name/chat/completions` | HTTP 503 — not_measured | HTTP 503 — not_measured | verified / verified | Route-backed; no exemption. Focused test: `src/connectors/cascade/cascade-router.service.spec.ts`. |
| `src/connectors/connectors.controller.ts` | `POST /connectors/:name/execute` | HTTP 400 — verified | HTTP 400 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/connectors/connectors.controller.spec.ts`. |
| `src/connectors/connectors.service.ts` | `GET /connectors/catalog` | HTTP 200 — verified | HTTP 200 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/connectors/connectors.service.policy.spec.ts + src/connectors/connectors.service.spec.ts`. |
| `src/connectors/failover/failover-router.service.ts` | `POST /v1/chat/completions` | HTTP 503 — not_measured | HTTP 503 — not_measured | verified / verified | Route-backed; no exemption. Focused test: `src/connectors/failover/failover-router.service.spec.ts`. |
| `src/health/health.controller.ts` | `GET /health/ready` | HTTP 503 — not_measured | HTTP 200 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/health/health.controller.spec.ts`. |
| `src/openai-compat/openai-compat.controller.ts` | `GET /v1/models` | HTTP 200 — verified | HTTP 200 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/openai-compat/openai-compat.controller.spec.ts`. |
| `src/prompt-cache/prompt-cache-prewarm.controller.ts` | `POST /v1/prompt-cache/prewarm` | HTTP 400 — verified | HTTP 400 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/prompt-cache/prompt-cache-prewarm.controller.spec.ts`. |
| `src/speech/speech.controller.ts` | `POST /v1/speech/tts` | HTTP 400 — verified | HTTP 400 — verified | verified / verified | Route-backed; no exemption. Focused test: `src/speech/speech.controller.spec.ts`. |
| `src/speech/stt/stt-async.controller.ts` | `GET /v1/speech/stt/jobs/:id` | HTTP 404 — not_measured | HTTP 404 — not_measured | verified / verified | Route-backed; no exemption. Focused test: `src/speech/stt/stt-async.controller.spec.ts`. |

## Evidence locations

- Candidate raw HTTP observations: `route-sweep-raw/result.json`; classified CanaryResult/v1: `route-sweep-classified/result.json` (48 entities, including all 13 route/code-unit pairs).
- Base HTTP negative control: `route-sweep-base/result.json`; tri-valued base result: `route-sweep-base-classified/result.json`.
- Candidate process CanaryResult/v2: `process-candidate/result.json`; base process control: `process-base/result.json`.
- Candidate HTTP counts over 70 probes: `verified=62`, `not_measured=6`, `failed=2`. The two failed HTTP 500s are STT routes and remain failed; base showed the same two 500 routes. The base sweep also records its disposable-key DELETE probe as 404 because the candidate-only disposable key ID is not present in base.
- Process canaries prove only the named unit-scoped tests, not real provider execution, live billing, production health, or runtime acceptance. No deployment claim is made.
