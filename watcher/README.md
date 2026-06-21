# Model Connector Watcher

Standalone, fail-closed observer for Model Connector provider health. It reads the four public health routes, classifies deterministic failures, evaluates rate and latency windows independently, persists atomic state/audit records, and emits authenticated Ops Bot events.

Default configuration is shadow-safe: circuit reset, failover, catalog writes, and bounded canaries are disabled. Health binds only to `127.0.0.1:3911`. State and audit files live under `/var/lib/model-connector-watcher/` with mode `0600`.

Dependency gates:

- CONN-0223 cascade adapter has `contractVersion=null` and cannot mutate.
- CONN-0226 catalog writer has `contractVersion=null` and cannot mutate.

Run local fixtures:

```bash
pnpm --dir watcher build
node watcher/dist/src/main.js --once --fixture watcher/test/fixtures/rate-quota.json
pnpm --dir watcher test
bats watcher/test/classification.bats
```

Rollout levels are L0 static/unit verification, L1 fixture CLI, L2 test-environment observation, L3 production shadow observation, and L4 separately approved bounded mutation. Production deployment, token provisioning or rotation, service restart, and mutation-toggle activation are operator-gated and are not performed by `/dr-do`.
