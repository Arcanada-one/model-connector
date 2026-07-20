# How to: Deploy Model Connector to PROD

Operator runbook for the Model Connector deploy pipeline and recovery from container-name race conditions on `arcana-prod`.

## When deploy fires

Every push to `main` triggers the `CI & Deploy` GitHub Actions workflow. After the `lint-and-test` and `docker-e2e` jobs go green, the `deploy` job runs on the `self-hosted, Linux, arcana-prod` runner:

1. SSH into `arcana-prod` as `${{ secrets.DEPLOY_USER }}`.
2. `cd /srv/apps/model-connector && git pull --ff-only origin main`.
3. `docker compose -f docker-compose.yml -f docker-compose.codex.yml down --remove-orphans || true` — explicit teardown of model-connector + codex-sidecar containers and any compose orphans. Named volumes (`claude-auth`, `cursor-auth`, `cursor-config`, `gemini-auth`, `codex-bin`) are preserved because no `-v` flag is passed.
4. `docker compose -f docker-compose.yml -f docker-compose.codex.yml up -d --build` — recreate containers from the new image.
5. `sleep 10 && curl -fsS http://localhost:3900/health` — health probe; fail surfaces the last 50 log lines and exits non-zero.
6. CONN-0073 codex overlay env regression check (`CODEX_BINARY_PATH`, `CODEX_HOME`, `CODEX_VAULT_ROLE_ID`, `CODEX_VAULT_SECRET_ID`).
7. Concurrency guard: `concurrency: deploy-model-connector, cancel-in-progress: false` — overlapping pushes queue serially.

Reference: `.github/workflows/ci.yml § deploy`.

## Race-condition history

A container-name race condition was observed on `2026-05-18` after CONN-0104 tightened the `start_period` / `healthcheck` configuration. The `docker compose up -d --build` command attempted to allocate the container name `model-connector-model-connector-1` before the previous instance had transitioned to a clean stopped state, producing:

```
Container model-connector-model-connector-1 ... already in use by container <hash>...
```

CONN-0106 recovered PROD manually with `docker rm -f`. CONN-0208 added the `docker compose down --remove-orphans || true` step before `up -d --build` to make the cleanup idempotent and pipeline-driven.

Trade-off: the explicit `down` introduces a momentary `~3-5s` availability dip while the container stops and is recreated. The deploy concurrency group (`deploy-model-connector`, `cancel-in-progress: false`) prevents overlapping runs. A zero-downtime blue-green migration is tracked as a future backlog candidate.

## Manual recovery when the cleanup step fails

If the `down --remove-orphans` step somehow leaves an orphan container holding the name (e.g. stuck on shutdown grace), recover from `arcana-prod` (see § SSH host form below for the address rationale):

```bash
ssh root@100.121.155.54
cd /srv/apps/model-connector
docker rm -f model-connector-model-connector-1 || true
docker rm -f model-connector-codex-sidecar-1 || true
docker compose -f docker-compose.yml -f docker-compose.codex.yml up -d --build
sleep 10
curl -fsS http://localhost:3900/health
```

Named volumes survive `docker rm -f` (volumes are only removed by `docker volume rm`). After the next push to `main`, the workflow's cleanup step will resume idempotent operation.

## Verifying a deploy was clean

```bash
# Workflow job status
gh run list --workflow "CI & Deploy" --branch main --limit 1 --json conclusion,jobs

# PROD health endpoint
curl -fsS https://connector.arcanada.ai/health   # → 200 {status:ok, ...}

# Named volume preservation gate
ssh root@100.121.155.54 'docker volume ls --format "{{.Name}}" \
  | grep -E "claude-auth|cursor-auth|cursor-config|gemini-auth|codex-bin"' | wc -l
# Expected: 5

# CONN-0073 codex overlay regression
ssh root@100.121.155.54 docker exec model-connector-model-connector-1 \
  sh -c 'echo $CODEX_BINARY_PATH'
# Expected: /codex-sidecar/bin/codex
```

## SSH host form

Every command in this runbook addresses the production host by its Tailscale IP literal (`100.121.155.54`), not by the MagicDNS nickname `arcana-prod`. `arcana-prod` also carries a public Hetzner `A` record (`65.108.236.39`); on operator machines without an `/etc/hosts` override the MagicDNS name resolves to the public IP and SSH then runs against the public interface — which is firewalled to Tailscale traffic only and returns `Connection refused` from a fresh dev machine. The Tailscale IP literal works on every machine joined to the Arcanada tailnet without per-machine DNS preference tuning.

If you prefer the nickname, add the Tailscale IP to `/etc/hosts` (`100.121.155.54 arcana-prod`) or set Tailscale's `--accept-dns=true` so MagicDNS is consulted before the public resolver. The hardcoded IP is the most portable form for an operator runbook.

Reference: workspace memory `feedback_tailscale_magicdns_not_default`.

## Future work

Pre-deploy preflight composite action is tracked separately at `Arcanada-one/datarim/.github/actions/preflight-check@v1` (CI Pre-deploy Health Checks Mandate). Model Connector adoption of the preflight action is out of scope for CONN-0208; it lands as a follow-up.
