# PR207 candidate sweep and process-canary receipt

Captured: 2026-10-14 UTC. Candidate source head: `8e21d4bc5c5e64e3616d18960ccc36294258dff2` (tree `069d0e2761879f85212274c916e7620f413d1314`). This is measurement evidence only; it does not establish CAR admission, review, hosted CI, merge, deployment, or production behavior.

## Route sweep

The acknowledged frozen route plan has digest `b4cbb6e2e6ddc51c3d3cb14f09d740bd492578f015153058cd85a75c7c06ec94`. Its source-bound result covers 30 routes and 60 requests: 60 verified, 0 failed, 0 not measured, and no HTTP 5xx. These checks establish route reachability/auth response classes; they do not assert business success for intentionally minimal/invalid request bodies.

The no-egress shim logged 89 blocked outbound HTTP attempts before they reached a network socket: 49 during candidate startup/catalog warm-up and 40 during the two `/health/connectors` requests (20 connector checks each). Host-only shim logging does not retain request paths. The source/application logs map the first group to provider/catalog startup refreshes and the second to `GET /health/connectors` calling `getStatus()` on registered connectors. Host breakdown:

| Destination host | Startup warm-up | `/health/connectors` | Total | Classification |
|---|---:|---:|---:|---|
| `http://100.90.7.20:8300` | 2 | 2 | 4 | Arcanada internal embedding service; finding |
| `http://127.0.0.1:11434` | 3 | 2 | 5 | local Ollama provider endpoint; blocked, not a fake service |
| `https://api.anthropic.com:443` | 2 | 2 | 4 | external provider API |
| `https://api.cerebras.ai:443` | 2 | 2 | 4 | external provider API |
| `https://api.cloudflare.com:443` | 2 | 2 | 4 | external provider API |
| `https://api.cohere.com:443` | 2 | 2 | 4 | external provider API |
| `https://api.fireworks.ai:443` | 2 | 2 | 4 | external provider API |
| `https://api.groq.com:443` | 3 | 2 | 5 | external provider API |
| `https://api.mistral.ai:443` | 3 | 2 | 5 | external provider API |
| `https://api.openai.com:443` | 3 | 2 | 5 | external provider API |
| `https://api.openmodel.ai:443` | 3 | 2 | 5 | external provider API |
| `https://api.orq.ai:443` | 3 | 2 | 5 | external provider API |
| `https://api.perplexity.ai:443` | 2 | 2 | 4 | external provider API |
| `https://api.together.xyz:443` | 2 | 2 | 4 | external provider API |
| `https://api.x.ai:443` | 3 | 2 | 5 | external provider API |
| `https://generativelanguage.googleapis.com:443` | 3 | 2 | 5 | external provider API |
| `https://ollama.com:443` | 3 | 2 | 5 | external provider API |
| `https://openrouter.ai:443` | 3 | 2 | 5 | external provider API |
| `https://router.huggingface.co:443` | 2 | 2 | 4 | external provider API |
| `https://us-central1-aiplatform.googleapis.com:443` | 1 | 2 | 3 | external provider API |

Eighty attempts targeted public provider API hosts and were denied; five targeted the local Ollama provider endpoint `127.0.0.1:11434` and were denied; four targeted `100.90.7.20:8300`, the configured Arcanada embedding service. The embedding traffic is an explicit finding because it is an internal Arcanada service, not a provider stub. Source mapping: `EmbeddingConnector` uses `DEFAULT_EMBEDDING_API_URL`; startup catalog refresh calls its `/models` path, and `BaseApiConnector.getStatus()` probes `/health` when `/health/connectors` runs. The 5 local Ollama attempts are provider endpoints but were not replaced by the DeepSeek fake provider; the shim denied them and no local Ollama response was used.

All 60 route observations ran with the shim blocking external fetch attempts; no request reached an external host. A separate same-head health readback returned HTTP 200 with JSON `status=degraded` and 29 connector records; `deepseek` was healthy through the local fake provider, while `embedding`, `openrouter`, `gemini-api`, `groq`, `ollama`, and `ollama-cloud` were unhealthy/unavailable. This confirms the endpoint did not report unavailable providers as healthy and its result did not rely on a live external answer. The supplemental health-readback launch generated 69 separately logged blocked attempts (49 startup + 20 for one health request); these are not included in the original 89-attempt sweep count.

Synthetic client credential file absence was verified after the sweep; both synthetic client keys were revoked and read back inactive. The temporary candidate admin-token file was also shredded after the readback. Candidate app, fake provider, isolated PostgreSQL and Redis were stopped; the owned ports 15582/15583/15584/16389 were no longer listening. No real provider key or production client credential was used.

## Twelve process canaries

A source-bound `CanaryResult/v2` for the exact same candidate tree ran 12 focused Vitest processes, one per affected code unit. All 12 terminated with exit 0 and are recorded as verified. The plan digest is `6be0c9a1dbb3ae328ae92f587dd7b8838acf1ed8869291add68a519b2a88e526`; result SHA-256 is `a9d41c6d92ef2dacc279206524ff8dfd3a44f4375b6fa6498976e1818e05730b`.

| Code unit | Focused spec | Outcome |
|---|---|---|
| `src/admin/admin.controller.ts` | `src/admin/admin.controller.spec.ts` | verified, exit 0 |
| `src/admin/circuit-breaker.controller.ts` | `src/admin/circuit-breaker.controller.spec.ts` | verified, exit 0 |
| `src/admin/watcher-repair.controller.ts` | `src/admin/watcher-repair.controller.spec.ts` | verified, exit 0 |
| `src/billing/credits.controller.ts` | `src/billing/credits.controller.spec.ts` | verified, exit 0 |
| `src/connectors/cascade/cascade-router.service.ts` | `src/connectors/cascade/cascade-router.service.spec.ts` | verified, exit 0 |
| `src/connectors/connectors.controller.ts` | `src/connectors/connectors.controller.spec.ts` | verified, exit 0 |
| `src/connectors/connectors.service.ts` | `src/connectors/connectors.service.policy.spec.ts` | verified, exit 0 |
| `src/connectors/failover/failover-router.service.ts` | `src/connectors/failover/failover-router.service.spec.ts` | verified, exit 0 |
| `src/openai-compat/openai-compat.controller.ts` | `src/openai-compat/openai-compat.controller.spec.ts` | verified, exit 0 |
| `src/prompt-cache/prompt-cache-prewarm.controller.ts` | `src/prompt-cache/prompt-cache-prewarm.controller.spec.ts` | verified, exit 0 |
| `src/speech/speech.controller.ts` | `src/speech/speech.controller.spec.ts` | verified, exit 0 |
| `src/speech/stt/stt-async.controller.ts` | `src/speech/stt/stt-async.controller.spec.ts` | verified, exit 0 |

The runner captures stdout/stderr as digests only, and reports `escaped_descendants=not_proven_absent`; this receipt therefore proves each owned test process exited successfully, not absence of detached descendants or full-suite coverage. No separate base-branch negative-control or mutation run is included in this 12-process receipt.

## Evidence inventory

| Artifact | SHA-256 |
|---|---|
| Frozen route plan | `b4cbb6e2e6ddc51c3d3cb14f09d740bd492578f015153058cd85a75c7c06ec94` |
| Route sweep result | `1b206515c59206567d9e24d528161080a98fcdc00af2f3c438e8f1fa427da9d3` |
| Route source evidence | `37f46b63c9aa4f2b20b7e7772fc1812938d87375a52d6a7694561df54bd38849` |
| Process-canary plan | `6be0c9a1dbb3ae328ae92f587dd7b8838acf1ed8869291add68a519b2a88e526` |
| Process-canary result | `a9d41c6d92ef2dacc279206524ff8dfd3a44f4375b6fa6498976e1818e05730b` |
| Process source evidence | `7cfeb2e0e5df20b82129479017be8f9310799ba56fcd27a48672ba6e6ab9b788` |
| Original 89-attempt blocked-egress log | `8d3b763c3691d5e55708721f263dc15b3c8042cdb829ddb77cb0998a5417eb7a` |
| Supplemental health JSON readback | `0209fe701a9972dc5e601736b5f2b3c54b197ce85f873c82c9100fddbe3c100d` |
| Supplemental blocked-egress log | `85df08edbcb9122b298079e92ee946c4d94ca13404dbeed9c08d5583cdba0f5f` |

## Internal embedding endpoint follow-up

The candidate inherited the address from source/configuration, not a local dotenv override: `src/config/env.schema.ts:24` defines `DEFAULT_EMBEDDING_API_URL` as `http://100.90.7.20:8300`, while the sanitized launcher omitted `EMBEDDING_API_URL`. `.env.example:153` also carries this default. Root accepted the embedding and local Ollama observations as harness limitations for this sweep; the source-default cleanup is a separate non-blocking task, `92376377-1c4b-4f82-a741-f80f6c32489f`.
