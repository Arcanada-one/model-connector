# CONN-0294 physical TDD test design

The RED commit intentionally imports an absent `ibm-watsonx-ai.connector` production module. The unchanged focused suite must fail at module resolution. Production is added only in the following GREEN commit.

The suite freezes:

- exact API date and seven IBM service bases with no default;
- exact text and native-image methods, paths, query, headers, and body keys;
- project and space scope variants with no deployment scope;
- caller-supplied opaque model IDs and no capability catalogue;
- strict JSON text output versus copied PNG bytes;
- exact-key configuration, request, transport-response, provider-error, and text-result validation;
- ordinary data records, descriptor safety, dangerous-key rejection, cycles, depth, width, node count, strings, arrays, result count, token count, and image-byte limits;
- one attempt, deterministic abort timeout, fixed local errors, and no raw input/output/cause/token leakage;
- copied/frozen structured results and copied image bytes; and
- static absence of network clients, environment lookup, retry, registration, discovery, SDK, deployment, and AI Gateway code.

All transport behavior is represented by an injected Vitest function. No test creates a socket or contacts IBM.
