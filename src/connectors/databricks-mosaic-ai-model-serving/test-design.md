# CONN-0296 test design

## Contract under test

The suite defines exactly four dormant methods behind a mandatory injected already-authorized transport:

1. native standard-workspace invocation;
2. list serving endpoints without pagination;
3. get one serving endpoint for lifecycle/configuration observation; and
4. get the conditional Public Preview endpoint OpenAPI schema.

The cloud label never derives a host. Provider JSON is endpoint owned and remains bounded opaque data. Management mutation, account APIs, route-optimized invocation, token acquisition, OpenAI-compatible façades, endpoint-type specialization, streaming, pagination, polling, retry, SDK use, registration, and built-in networking are negative boundaries.

## Physical RED rule

The first commit contains this test, the handwritten fixture module, this design, and fixture provenance only. It imports `./databricks-mosaic-ai-model-serving.connector`, which must not exist. The focused Vitest invocation must fail specifically because that production module is unresolved. The GREEN commit may add only that production module and may not modify any RED artifact.

## Coverage groups

- exact configuration keys, API version, cloud labels, workspace HTTPS-origin validation, timeout, and injected transport;
- exact operation request keys, methods, paths, headers, endpoint identity, list no-query behavior, and optional invocation response header;
- lifecycle/configuration/served-entity and OpenAPI documents preserved without normalization;
- ordinary safe records, descriptor-first rejection, dangerous keys, prototype pollution, cycles, depth, width, arrays, node count, strings, total bytes, identifiers, origins, and immutable copies;
- one transport attempt, abort timeout, response/media/status validation, fixed status-only redaction, and zero calls on invalid input;
- static and API-shape exclusions for networking, credentials, registration, mutation, retry, polling, OpenAI, route optimization, account APIs, and adjacent connectors.

No test represents live readiness. All provider-shaped data is synthetic as documented in `fixture-provenance.md`.
