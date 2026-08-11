# CONN-0295 physical TDD test design

The RED commit imports an absent `oracle-oci-generative-ai.connector` production module. The unchanged focused suite must fail at module resolution. Production is added only in the following GREEN commit.

The suite freezes:

- API date `20231130`, thirteen current region/realm mappings, and separate derived native-inference and management hosts;
- seven native inference and five read-only management method/path identities;
- JSON-only inference, exact local headers, deterministic query order, explicit one-page pagination, and RFC3986 path encoding;
- compartment-header versus compartment-query scope and preservation of synthetic on-demand/dedicated provider documents;
- exact connector-owned configuration, request, transport-response, and response-header keys;
- ordinary data records, descriptors, symbols, dangerous keys, prototypes, cycles, depth, width, node, array, string, serialized-byte, identifier, page, limit, and timeout bounds;
- one transport attempt, abort timeout, fixed local errors, optional safe status, and no raw document/header/URL/cause leakage;
- copied/frozen transport inputs and returned JSON; and
- static absence of HTTP clients, environment/filesystem access, SDK/signing/bearer/retry/registration/mutation/OpenAI/Agents/Database code.

All transport behavior is represented by an injected Vitest function. No test creates a socket or contacts Oracle.
