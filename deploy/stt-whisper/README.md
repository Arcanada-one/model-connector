# STT Whisper deploy stack

Self-hosted `faster-whisper-server` on **arcana-ai** (100.81.64.51).
Consumed by Model Connector workers via `LOCAL_WHISPER_BASE_URL=http://arcana-ai:8400`.

## Topology

| Layer | Value |
|-------|-------|
| Host | arcana-ai (Tailscale 100.81.64.51) |
| Container | `stt-whisper` |
| Image | `fedirz/faster-whisper-server@sha256:760e5e43d427dc6cfbbc4731934b908b7de9c7e6d5309c6a1f0c8c923a5b6030` |
| Model | `Systran/faster-distil-whisper-large-v3` (INT8 CT2) |
| Port | host `127.0.0.1:8400` → container `8000` |
| Exposure tier | 2 (Tailscale-only) |
| RAM | `mem_limit=4g` (Phase 0 peak 3.25 GiB) |
| CPU | `cpus=4.0` (entire host, no GPU) |
| Concurrency | `1` enforced by worker side (`STT_LOCAL_WHISPER_MAX_CONCURRENCY=1`) |

## Network exposure

Tier 2 mitigation runs on three layers:

1. **Docker bind** — `127.0.0.1:8400:8000` (loopback only, no `0.0.0.0`).
2. **Host firewall** — UFW allows inbound TCP 8400 on `tailscale0` only; denies on `eth0`/`wan0`.
3. **Tailscale ACL** — workers from `arcana-prod` and `arcana-db` reach `arcana-ai:8400`;
   no public DERP exposure outside the tailnet.

Verified via `dev-tools/network-exposure-check.sh --compose deploy/stt-whisper/docker-compose.yml`.

## Deploy

CI handles deploy on push to `main` via
`.github/workflows/deploy-stt-whisper.yml` (runner label `arcana-ai,docker`).

Manual run on the host (operator-only):

```bash
ssh arcana-ai
cd /srv/apps/stt-whisper
git pull --ff-only origin main
docker compose -f deploy/stt-whisper/docker-compose.yml up -d
docker compose -f deploy/stt-whisper/docker-compose.yml ps
```

First boot downloads the model (~1.5 GiB) into the named volume
`whisper_hf_cache`. Subsequent restarts reuse the cache.

## Health probe

```bash
curl -fsS http://localhost:8400/health
# {"status":"ok"}
```

From a Model Connector worker on `arcana-prod`:

```bash
curl -fsS http://arcana-ai:8400/health
```

## Rollback

```bash
cd /srv/apps/stt-whisper
docker compose -f deploy/stt-whisper/docker-compose.yml down
```

Container stops; named volume `whisper_hf_cache` is preserved for the next bring-up.
Application-side rollback uses the kill-switch
`STT_PROVIDER_LOCAL_WHISPER_ENABLED=false` in Model Connector env, which routes
all `/v1/speech/stt/async` requests to the existing budget guard
(returns `503 stt_all_providers_exhausted`).

## Image bump policy

The image digest is pinned. Bumping requires:

1. New Phase-0-style fixture capture (RTF + RAM + response shape) on arcana-ai.
2. PR that updates `image:` digest and `datarim/tasks/CONN-0101-fixtures.md`.
3. CONN-0104 reflection note (or sibling `CONN-*` task) explaining the bump.

Renovate/Dependabot ignore until then.
