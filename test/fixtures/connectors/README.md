# Connector `/models` fixtures (CONN-0236)

Captured provider model-list responses used by the dynamic-model-completeness tests.
CI **never** makes a live provider call — these fixtures stand in for the real
`{baseUrl}/models` responses so `refreshModels()` parsing/merge can be exercised
deterministically. Every model id below is traceable to a live API response or a
cited, dated source — **no invented ids** (anti-fabrication mandate).

| Fixture | Provenance | Notes |
|---------|------------|-------|
| `groq-models.json` | **Live capture** — `GET https://api.groq.com/openai/v1/models`, arcana-dev, 2026-06-23 (HTTP 200). | Verbatim response, 17 entries with `input_modalities`/`output_modalities`. Includes non-chat families (whisper STT, orpheus TTS, llama-prompt-guard) that `GroqConnector.extractModelIds()` filters out by audio modality. |
| `openmodel-models.json` | **Operator live-verified**, Mac, 2026-06-23 — `GET https://api.openmodel.ai/v1/models` returned 32 models; the concrete ids enumerated in the CONN-0236 hand-off are reproduced here. | Subset of the real 32 (the hand-off abbreviated `claude-*` and `gemini-3.*` families; those are omitted rather than guessed). The full 32 populate at runtime on the cluster where `OPENMODEL_API_KEY` exists. Anthropic-compatible `{object:"list", data:[{id}]}` shape. |
| `grok-models.json` | **Cited static ids** — reproduced from the `GrokConnector` static list (CONN-0233, reviewed 2026-06-22, source docs.x.ai). No live xAI key on the dev box, so this is a shape-accurate (`docs.x.ai` OpenAI-compatible `{data:[{id,object,owned_by}]}`) stand-in built **only** from already-cited ids — not a live capture and not invented. Carries no fabricated metadata (no synthetic `created` timestamps); `refreshModels()` reads only `id`. The real list populates at runtime on the cluster where `XAI_API_KEY` exists. |

Gemini is intentionally absent: it is a CLI connector (different, Google-shaped API)
and stays curated-dated per the hand-off — no OpenAI-shape fetch is forced on it.
