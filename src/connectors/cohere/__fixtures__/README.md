# Cohere synthetic fixture provenance

Every JSON file in this directory is deterministic, hand-authored synthetic test data. No file is a captured provider response, and no Cohere request, credential, account, or paid operation was used.

The shapes were derived from Cohere's public first-party references on 2026-07-19:

- `POST /v2/embed`: https://docs.cohere.com/v2/reference/embed
- `POST /v2/rerank`: https://docs.cohere.com/v2/reference/rerank
- `GET /v1/models`: https://docs.cohere.com/reference/list-models
- model catalogue and lifecycle: https://docs.cohere.com/docs/models and https://docs.cohere.com/docs/deprecations

Identifiers and numeric values are deliberately synthetic. Model-like fixture IDs are used only to exercise documented endpoint/deprecation filtering and are not a runtime support catalogue.
