# Connector `/models` fixtures (CONN-0236, refreshed CONN-0238)

Captured provider model-list responses used by the dynamic-model-completeness tests.
CI **never** makes a live provider call — these fixtures stand in for the real
`{baseUrl}/models` responses so `refreshModels()` parsing/REPLACE/classification can
be exercised deterministically. Every model id, price and context value below is
traceable to a live API response — **nothing is invented** (anti-fabrication mandate).

CONN-0238 switched `refreshModels()` from `static ∪ provider` (UNION) to **REPLACE**:
on a successful fetch the live list is the sole source of truth, so these fixtures
define the exact catalog each connector exposes at runtime.

| Fixture | Provenance | Notes |
|---------|------------|-------|
| `groq-models.json` | **Live capture** — `GET https://api.groq.com/openai/v1/models`, arcana-dev, 2026-06-23 (HTTP 200). | Verbatim 17 entries with `input_modalities`/`output_modalities`, `pricing`, `context_window`, `max_completion_tokens`. CONN-0238 surfaces ALL with per-model modality: chat (11), STT whisper (2), TTS orpheus (2), moderation prompt-guard (2). |
| `openmodel-models.json` | **Operator live capture**, 2026-06-23 — `GET https://api.openmodel.ai/v1/models` (34 models). | The full 34 real ids. Replaces the old 18-id fixture; the dead `deepseek-r2` / `qwen3-235b` are gone from the live API and are no longer present. Anthropic-compatible `{object:"list", data:[{id}]}` shape. |
| `grok-models.json` | **Operator live capture**, 2026-06-23 — `GET https://api.x.ai/v1/models` (9 models). | The real 9 ids — chat (grok-4.3, grok-4.20-*, grok-build-0.1) + image (grok-imagine-image*) + video (grok-imagine-video*). Replaces the CONN-0236 phantom static list (grok-4-fast/grok-3/…) that the UNION refresh leaked to prod. xAI `/v1/models` exposes ids only — no pricing/context. |
| `openrouter-models.json` | **Live capture** — `GET https://openrouter.ai/api/v1/models` (public, no auth), arcana-dev, 2026-06-23. | All **340** entries (26 free), trimmed to the fields the parser reads: `id`, `context_length`, `pricing.{prompt,completion}`, `top_provider.{context_length,max_completion_tokens}`. Real ids + real prices. CONN-0238 surfaces all 340 (free-flagged), not free-only. |

Gemini is intentionally absent: it is a CLI connector (different, Google-shaped API)
and stays curated-dated — no OpenAI-shape fetch is forced on it.
