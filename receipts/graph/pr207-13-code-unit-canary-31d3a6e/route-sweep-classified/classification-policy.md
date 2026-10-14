# Classification policy for the PR #207 route sweeps

The raw route-sweep JSON is immutable input to this classification. Each HTTP status and response observation remains present in the raw and classified results.

For both candidate `31d3a6e3e008acc446af1c2440a8d1a51fc392b5` and base `bb70aae82e78678dfb4e8f13621582ae6bd8cf74`, classify these exact no-egress provider paths as `not_measured` when their observed status is 503: `GET /connectors/intents/:intentId`, `POST /connectors/:name/chat/completions`, and `POST /v1/chat/completions`. For candidate `GET /health/ready`, the observed 503 is `not_measured` because the required provider is unavailable under the no-egress shim; base returned 200. `GET /v1/speech/stt/jobs/:id` is `not_measured` at observed 404 because no STT job fixture was created.

Every other result preserves the route-sweep classification. In particular, both STT POST 500s remain `failed` on candidate and base. The base-only admin DELETE 404 also remains `failed`: its route parameter is a candidate-only disposable key id absent from the base database, so that probe is not used as evidence for a mapped code unit.

The mapping is evidence metadata only: an authorized probe carries its route entity and, when applicable, the corresponding `code_unit:` entity. The unauthenticated control carries only the route entity. The process CanaryResult/v2 pair independently records one focused test process per code unit on candidate and base.
