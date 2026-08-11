# CONN-0294 synthetic fixture provenance

Every fixture in this directory is handwritten, deterministic, and synthetic. None was captured from IBM traffic, an authenticated catalogue, a model, an SDK runtime, or a provider account.

The field names and shapes are derived only from the first-party IBM watsonx.ai API reference accessed anonymously on 2026-07-20 and frozen in the workflow research artifacts. Values use conspicuous `synthetic` labels and reserved local examples. Model IDs are intentionally fictional and assert no availability. The byte fixture contains only the eight-byte PNG signature; it is not a generated image.

The fixtures prove local request construction, validation, representation separation, immutability, timeout behavior, and redaction. They do not prove entitlement, billing, IAM authorization, regional rollout, model lifecycle, inference quality, or live service behavior.
