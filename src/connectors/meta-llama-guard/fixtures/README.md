# CONN-0292 synthetic generation fixtures

`generation.synthetic.ts` contains handwritten deterministic values created only
for offline contract tests. They were never captured, copied, replayed,
transformed, paraphrased, or derived from Meta, a model, a runtime, a provider
response, or an authenticated source.

The fixture strings exercise the current first-party-proven generated-output
boundary: `safe` and a single `unsafe` category line. They are not empirical
observations and do not prove model availability, quality, delimiter behavior
beyond the frozen parser, or deployment correctness.

Evidence consulted, not copied:

- https://github.com/meta-llama/PurpleLlama/blob/main/Llama-Guard4/12B/MODEL_CARD.md
- https://huggingface.co/meta-llama/Llama-Guard-4-12B (verified Meta-owned model
  page; visible model-card content only; no gated file or weight access)

Access date: 2026-07-20.

SHA-256 of `generation.synthetic.ts`:
`1a85821b4eb4c92bbc2785815712a4668a3df4c16059d3a51fd2df45ebc8cd7a`.
