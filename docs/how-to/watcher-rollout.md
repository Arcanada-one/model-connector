# Roll out the Model Connector watcher

## L0–L1: local verification

Build the watcher, run all Vitest suites, and run `classification.bats` against the compiled CLI. Keep every mutation toggle false.

## L2: test environment

Install files under a versioned release directory, provide a dedicated Ops Bot token, and run observation against the test Model Connector Tailscale endpoint. Verify heartbeat, dead-man, classification, redaction, and alert delivery before considering recovery.

## L3: production shadow

Production deployment and service start are operator-gated. In shadow mode, collect at least seven continuous days and 500 samples per active provider/model. Mutation toggles remain false.

## L4: bounded capabilities

Each capability requires a separate operator decision:

1. Provision the scoped `WATCHER_REPAIR_TOKEN` and enable circuit reset only after shadow evidence passes.
2. Keep failover disabled until CONN-0223 publishes a versioned tested contract.
3. Keep catalog writes disabled until CONN-0226 publishes its versioned write/read contract.

Token provisioning or rotation, service restart, production deployment, and mutation-toggle activation are outside `/dr-do`.
