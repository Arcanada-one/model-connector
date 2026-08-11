# AI21 native contract fixture provenance

These fixtures are handwritten, deterministic, synthetic examples for CONN-0298 / AU-041.

- They were never sent to AI21 or any other provider.
- They are not captures, recordings, generated model output, customer data, credentials, or authenticated catalogue data.
- Their conspicuously synthetic IDs and text are local test values only.
- They model only the frozen AI21 Platform native SaaS Jamba Chat Completions subset.
- They do not establish live interoperability, error-body shape, geography, residency, retention, billing, alias, Batch, Maestro, RAG, tool, or Bedrock behavior.

## Source mapping

| Fixture               | Modeled first-party schema                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request.valid.json`  | https://docs.ai21.com/reference/jamba-1-6-api-ref and pinned official SDK `ai21/clients/studio/resources/chat/base_chat_completions.py`                    |
| `response.valid.json` | https://docs.ai21.com/reference/jamba-api-response and pinned official SDK `ai21/models/chat/chat_completion_response.py` plus `ai21/models/usage_info.py` |
| `stream.valid.sse`    | https://docs.ai21.com/reference/jamba-api-response and pinned official SDK `ai21/models/chat/chat_completion_chunk.py`                                     |

Official SDK pin: `AI21Labs/ai21-python@bbc422f6f955134c2e33a9473ec0f71d21611764`.

Canonical research provenance: `datarim/research/PROVENANCE-CONN-0298.md` in the assigned workflow worktree.

## Handwriting declaration

The request, response, token counts, IDs, message text, and SSE chunks were authored manually from the cited field descriptions. No provider or model supplied any fixture byte.
