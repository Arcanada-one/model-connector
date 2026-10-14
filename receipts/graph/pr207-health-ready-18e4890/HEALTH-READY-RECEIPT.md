# PR207 exact-head health evidence

- Measured candidate: `18e489033ed879849877aca629807a5367856b63`; source tree: `ebc2b418cc7e1a83716bfd8c2311f432db5906aa`.
- Scope: one additional route canary for `route:GET /health/ready` and one focused process canary for `code_unit:src/health/health.controller.ts`. Both receipts bind to the exact measured commit/tree above. The route canary produced HTTP 200 and verified that the route and JSON keys `status`, `checks`, and `providers` were present.
- Readback: `/health/ready` returned HTTP 200 with `status=degraded`, `checks.database=ok`, and `checks.requiredProviders=ok`; the required DeepSeek connector was `unavailable`, while optional providers were missing/unavailable. This demonstrates the unavailable-required-provider path does not make readiness 503. The focused `health.controller.spec.ts` process exited 0. Process-canary limits remain: escaped descendants are not proven absent.
- Environment: candidate app from the exact source tree; isolated PostgreSQL 16.15 and Redis on loopback-only non-default ports; synthetic DeepSeek-shaped environment value with no real credential. No external provider answer was used. All owned temporary services were stopped after measurement. No temporary client key was issued.
- The no-egress shim recorded 46 outbound HTTP attempts during this final candidate boot/readiness run. All were blocked before socket/network access. Host breakdown:

| Destination | Attempts | Result |
|---|---:|---|
| `http://100.90.7.20:8300` | 2 | blocked before network access |
| `https://api.anthropic.com:443` | 2 | blocked before network access |
| `https://api.cerebras.ai:443` | 2 | blocked before network access |
| `https://api.cloudflare.com:443` | 2 | blocked before network access |
| `https://api.cohere.com:443` | 2 | blocked before network access |
| `https://api.fireworks.ai:443` | 2 | blocked before network access |
| `https://api.groq.com:443` | 3 | blocked before network access |
| `https://api.mistral.ai:443` | 3 | blocked before network access |
| `https://api.openai.com:443` | 3 | blocked before network access |
| `https://api.openmodel.ai:443` | 3 | blocked before network access |
| `https://api.orq.ai:443` | 3 | blocked before network access |
| `https://api.perplexity.ai:443` | 2 | blocked before network access |
| `https://api.together.xyz:443` | 2 | blocked before network access |
| `https://api.x.ai:443` | 3 | blocked before network access |
| `https://generativelanguage.googleapis.com:443` | 3 | blocked before network access |
| `https://ollama.com:443` | 3 | blocked before network access |
| `https://openrouter.ai:443` | 3 | blocked before network access |
| `https://router.huggingface.co:443` | 2 | blocked before network access |
| `https://us-central1-aiplatform.googleapis.com:443` | 1 | blocked before network access |

- The source default `100.90.7.20:8300` is from `src/config/env.schema.ts:24` (`DEFAULT_EMBEDDING_API_URL`), not a local `.env` override. Follow-up is tracked as Muneral CONN task `92376377-1c4b-4f82-a741-f80f6c32489f` to remove host-bound production endpoint defaults from source.
- Prior acknowledged route sweep remains 60/60 verified over 30 routes, with 89 blocked outbound attempts; prior 12 process canaries were 12/12 verified. This additive exact-head evidence closes only the two uncovered CAR rows; it does not prove full-suite success, escaped-descendant containment, or production behavior.
- Route result SHA-256: `e9f2a3ecc01c1e494970a42fd47beb86ee6c11172ab2e03c6422886643c125c4`. Process result SHA-256: `b9abca060c4d64beeed5c68441a39ca5d3725e683f014bcdbc00ce4e1739808e`. Readback SHA-256: `26f645a7edbae528ee76627410d2d69c919fc7cfc47411188830746c71189070`.
