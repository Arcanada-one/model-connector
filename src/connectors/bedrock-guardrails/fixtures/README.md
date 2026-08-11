# CONN-0290 synthetic fixture provenance

Every JSON provider response in this directory was handwritten on 2026-07-20 from the current Amazon Bedrock API Reference response shapes listed in `datarim/research/INSIGHTS-CONN-0290.md` in the paired workflow worktree. They are deterministic synthetic examples, not AWS captures. No AWS SDK, API, account, credential, endpoint, metadata service, or live/paid request was used.

- `control-success.synthetic.json` contains separate synthetic bodies for CreateGuardrail, CreateGuardrailVersion, GetGuardrail, and UpdateGuardrail.
- `list-success.synthetic.json` is a synthetic ListGuardrails page with a continuation token.
- `apply-success.synthetic.json` is a synthetic ApplyGuardrail text-result body.
- `provider-error.synthetic.json` is a synthetic AWS JSON error body containing fake sensitive-looking values solely to verify redaction.

The PNG/JPEG bytes constructed in the spec are local deterministic test inputs, not provider responses. They contain only the signatures and dimension metadata needed to exercise the connector's documented preflight boundary. They are never uploaded or decoded by an external service.
