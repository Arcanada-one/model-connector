# CONN-0292 test contract

This directory is a dormant, unregistered offline unit. The physical RED commit
contains this document, the specification, and handwritten deterministic
synthetic fixtures/provenance only. Production must be absent, and the focused
run must fail specifically because `./meta-llama-guard-runtime.connector` cannot
be resolved.

The forward GREEN commit may add only `meta-llama-guard-runtime.connector.ts`,
`types.ts`, and `validation.ts`. It must not edit the RED artifacts.

Coverage freezes:

- exact model and connector-owned generation contract versions;
- prompt→user and response→assistant structured text messages;
- literal content preservation without a reconstructed Guard prompt;
- text-only modality and exact safe / one-category unsafe parsing;
- all S1–S14 labels without score or policy interpretation;
- descriptor-first safe-record, bound, immutability, timeout, one-call, no-retry,
  and redaction behavior;
- malformed, ambiguous, accessor, prototype, cyclic, deep, wide, and oversized
  request/generation values;
- no endpoint, network, auth, environment, model/runtime, process, registration,
  or dependency behavior.

All execution uses in-memory injected functions. No model/runtime output is
captured or replayed, and no live inference or provider call is permitted.
