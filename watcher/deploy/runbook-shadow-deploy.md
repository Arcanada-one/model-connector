---
doc_type: runbook
task_id: CONN-0230
parent: CONN-0227
created: 2026-06-22
status: ready-for-operator
target_host: arcana-dev
service: model-connector-watcher
---

# CONN-0230 — Model Connector Watcher: Shadow Deploy + Rollback Runbook

> **Deploy-preparation status (autonomous phase [A] complete):**
> All artefacts are built, committed, and verified. The steps below are exclusively
> operator-executable ([OG] = operator-gated per `autonomous-agents.md`).
> The watcher is shadow-safe by construction: all mutation toggles are OFF and the
> Zod schema rejects any config that enables them while `mode: shadow`.

## Connectivity precondition (must verify before OG1)

arcana-dev CANNOT reach arcana-prod MC via tailnet (100.121.155.54:3900 returns HTTP 000).
The shadow config uses the public domain `https://connector.arcanada.ai` (Traefik reverse
proxy to localhost:3900 on prod — verified 200 on all observation endpoints).

**Verify before proceeding:**
```bash
curl -sf https://connector.arcanada.ai/health/ready | jq .status
# Expected: "ok" or "ready"
```

---

## [OG1] Build and stage the release

**[OG] operator runs this** — build on arcana-dev from the feature branch:

```bash
ssh dev@65.109.56.79
cd "/home/dev/arcanada/Projects/Model Connector/code/watcher"
git branch
# Confirm: feat/conn-0227-watcher

pnpm build
ls -la dist/src/main.js dist/src/deadman-cli.js
# Both files must exist

RELEASE_DATE=$(date +%Y%m%d-%H%M)
RELEASE_DIR="/opt/model-connector-watcher/releases/${RELEASE_DATE}"
```

---

## [OG2] Install files (as root on arcana-dev)

**[OG] operator runs this** — the install script creates the service user and copies the
dist directory. It does NOT start or enable the service.

```bash
sudo bash scripts/install-local.sh \
  "/home/dev/arcanada/Projects/Model Connector/code/watcher" \
  "${RELEASE_DIR}"

# Verify symlink
ls -la /opt/model-connector-watcher/current
# Should point to RELEASE_DIR
```

---

## [OG3] Deploy shadow config

**[OG] operator runs this** — derive the prod config from the template (no real secrets
committed to the repo; the template is at `watcher/deploy/config.shadow.yaml`).

```bash
sudo install -d -m 0755 /etc/model-connector-watcher

# Copy the shadow config template
sudo cp "/home/dev/arcanada/Projects/Model Connector/code/watcher/deploy/config.shadow.yaml" \
  /etc/model-connector-watcher/config.yaml

# If opsbot.base_url needs to change from the template default, edit it:
# sudo nano /etc/model-connector-watcher/config.yaml

sudo chmod 0600 /etc/model-connector-watcher/config.yaml
sudo chown root:root /etc/model-connector-watcher/config.yaml

# Verify shadow invariants still hold after any edits:
node -e "
  import('./dist/src/config.js').then(async m => {
    const cfg = await m.loadConfig('/etc/model-connector-watcher/config.yaml',
      { OPSBOT_TOKEN: 'dummy-verify-only' });
    console.log('mode:', cfg.mode,
      'circuit_reset:', cfg.recovery.circuit_reset_enabled,
      'failover:', cfg.recovery.failover_enabled,
      'catalog_write:', cfg.catalog.write_enabled);
  });
" 2>&1
# Expected: mode: shadow, all three = false
```

---

## [OG4] Provision secrets

**[OG] operator runs this** — create the environment file. Values come from the
Arcanada Vault (`config/credentials/`). Do NOT commit these values.

```bash
sudo install -d -m 0755 /etc/model-connector-watcher
sudo tee /etc/model-connector-watcher/watcher.env > /dev/null << 'ENVEOF'
OPSBOT_TOKEN=<ops-bot-bearer-token-from-vault>
MC_API_KEY=<model-connector-api-key-from-vault>
ENVEOF
sudo chmod 0600 /etc/model-connector-watcher/watcher.env
sudo chown root:model-connector-watcher /etc/model-connector-watcher/watcher.env

# WATCHER_REPAIR_TOKEN is NOT needed in shadow (circuit_reset_enabled=false)
```

> **Note:** The shadow config uses `token_env: OPSBOT_TOKEN`. The `MC_API_KEY` is needed
> by the watcher client for the `/connectors/catalog` endpoint (Bearer auth). The systemd
> unit loads `watcher.env` via `EnvironmentFile`, so both vars are available at runtime.

---

## [OG5] Install systemd units

**[OG] operator runs this:**

```bash
sudo cp /home/dev/arcanada/Projects/Model\ Connector/code/watcher/systemd/model-connector-watcher.service \
  /etc/systemd/system/
sudo cp /home/dev/arcanada/Projects/Model\ Connector/code/watcher/systemd/model-connector-watcher-deadman.service \
  /etc/systemd/system/
sudo cp /home/dev/arcanada/Projects/Model\ Connector/code/watcher/systemd/model-connector-watcher-deadman.timer \
  /etc/systemd/system/

sudo systemctl daemon-reload
```

---

## [OG6] Enable and start

**[OG] operator runs this:**

```bash
sudo systemctl enable model-connector-watcher.service
sudo systemctl enable model-connector-watcher-deadman.timer

sudo systemctl start model-connector-watcher.service
sudo systemctl start model-connector-watcher-deadman.timer

# Allow 10 seconds for the first cycle to complete
sleep 10
sudo systemctl status model-connector-watcher.service
```

---

## [OG7] Post-start smoke check

**[OG] operator runs this:**

```bash
# 1. Health endpoint on loopback (must be 200)
curl -sf http://127.0.0.1:3911/ | jq .
# Expected: { "status": "ok" } or { "status": "degraded" } — degraded is OK in shadow
# (it means the last MC cycle was not 100% successful, not that the service is broken)

# 2. Check first heartbeat in state.json
sudo cat /var/lib/model-connector-watcher/state.json | jq .
# Expected: { "heartbeatAt": "<recent timestamp>", "lastCycleOk": true|false }

# 3. Journald log stream
sudo journalctl -u model-connector-watcher.service -n 20 --no-pager
# Look for: "watcher observation cycle completed"

# 4. Confirm no mutation events (shadow invariant)
sudo journalctl -u model-connector-watcher.service --no-pager | grep -i "fix_applied\|reset_circuit\|failover"
# Expected: empty output (no mutation events in shadow)

# 5. Confirm health bind is loopback (no public exposure)
sudo ss -tlnp | grep 3911
# Expected: 127.0.0.1:3911 ONLY (never 0.0.0.0 or ::)

# 6. Dead-man timer running
sudo systemctl status model-connector-watcher-deadman.timer
sudo journalctl -u model-connector-watcher-deadman.service -n 5 --no-pager
```

---

## [OG8] Verify first Ops Bot alert delivery (heartbeat)

The watcher emits a heartbeat to Ops Bot every `alerting.heartbeat_interval_ms = 30000ms`.
Within 30-60 seconds of start, you should see a heartbeat event in the Ops Bot channel
(AGENT-0010 Telegram channel or ops.arcanada.ai events feed).

```bash
# Force a test heartbeat by inspecting opsbot delivery logs:
sudo journalctl -u model-connector-watcher.service --no-pager | grep -i opsbot
# Should show successful POST to opsbot.base_url
```

If no heartbeat arrives within 2 minutes, check `OPSBOT_TOKEN` in `watcher.env` and verify
the Ops Bot endpoint responds:
```bash
curl -sf -o /dev/null -w "%{http_code}" https://ops.arcanada.ai/events \
  -H "Authorization: Bearer ${OPSBOT_TOKEN}" -H "Content-Type: application/json" \
  -d '{"type":"test"}'
```

---

## Rollback procedure

**[OG] operator runs this** — zero prod-MC impact (shadow is read-only):

```bash
# 1. Stop and disable the service
sudo systemctl stop model-connector-watcher.service model-connector-watcher-deadman.timer
sudo systemctl disable model-connector-watcher.service model-connector-watcher-deadman.timer

# 2. (Optional) Revert to previous release if it exists
PREV_RELEASE=$(ls -1t /opt/model-connector-watcher/releases/ | sed -n '2p')
if [[ -n "$PREV_RELEASE" ]]; then
  sudo ln -sfn "/opt/model-connector-watcher/releases/${PREV_RELEASE}" \
    /opt/model-connector-watcher/current
  sudo systemctl start model-connector-watcher.service
fi

# 3. (Full removal) Remove service files and data
# sudo systemctl stop model-connector-watcher.service
# sudo rm /etc/systemd/system/model-connector-watcher*.service \
#         /etc/systemd/system/model-connector-watcher*.timer
# sudo systemctl daemon-reload
# sudo rm -rf /opt/model-connector-watcher /etc/model-connector-watcher
# sudo userdel model-connector-watcher
# sudo rm -rf /var/lib/model-connector-watcher
```

**Rollback has zero prod-MC impact**: because shadow performs no mutations, stopping the
watcher at any point leaves prod MC byte-identical. The audit log and state file remain
on disk for post-mortem review.

---

## Shadow-mode constraint summary

| Setting | Value | Why |
|---------|-------|-----|
| `mode` | `shadow` | Master switch — Zod schema enforces all invariants below |
| `recovery.circuit_reset_enabled` | `false` | No automatic circuit resets |
| `recovery.failover_enabled` | `false` | No provider failover (CONN-0223 gate not yet verified) |
| `catalog.write_enabled` | `false` | Catalog diff alert only, no writes to `/connectors/catalog` |
| `observation.bounded_canary_enabled` | `false` | No synthetic probes |
| `health.bind_host` | `127.0.0.1` | Loopback only — no public listener |
| `catalog.fetch_enabled` | `true` | Catalog re-fetch is ON (read-only, alert-only) |
| `WATCHER_REPAIR_TOKEN` | not required | Only needed when `circuit_reset_enabled=true` |

Any attempt to set `circuit_reset_enabled`, `failover_enabled`, or `catalog.write_enabled`
to `true` while `mode: shadow` will throw `shadow mode forbids mutation toggles` at config
load time, preventing startup. Verified via V-AC-1 negative tests.
