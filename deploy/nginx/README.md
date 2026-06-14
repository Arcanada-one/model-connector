# nginx reverse-proxy vhosts (Model Connector)

`connector.arcanada.ai` is served by a **host-level nginx** on arcana-prod
(`65.108.236.39`), in front of the Dockerized Model Connector on `127.0.0.1:3900`.
nginx is **not** part of the Docker deploy or the GitHub Actions pipeline, so these
vhost files are the **IaC mirror / source of truth** — the live host copies live at
`/etc/nginx/sites-available/`.

| File | Purpose |
|------|---------|
| `connector.arcanada.ai.conf` | Active vhost: TLS (wildcard), rate-limit `zone=connector_api`, `proxy_read/send_timeout 600s` (long CLI runs), `client_max_body_size 32m` (STT audio uploads — CONN-0221), proxy → `127.0.0.1:3900`. |
| `connector.arcanada.one.conf` | Legacy domain: 301 → `connector.arcanada.ai` (ARCA-0155). Keeps the `limit_req_zone connector_api` declaration the `.ai` vhost references. |

## Why `client_max_body_size 32m`

The vhost originally had no `client_max_body_size` → nginx default **1m** → any STT
POST of audio > 1 MB returned `413 Request Entity Too Large` from nginx before
reaching the connector (a real 2 MB Telegram voice failed). `32m` covers the
connector/Groq 25 MiB STT ceiling with headroom. (CONN-0221, 2026-06-14.)

## Install / update on the host

```bash
# from this repo on the operator Mac:
scp deploy/nginx/connector.arcanada.ai.conf  root@65.108.236.39:/etc/nginx/sites-available/connector.arcanada.ai.conf
scp deploy/nginx/connector.arcanada.one.conf root@65.108.236.39:/etc/nginx/sites-available/connector.arcanada.one

ssh root@65.108.236.39 '
  # ensure both are enabled (symlinked into sites-enabled)
  ln -sf /etc/nginx/sites-available/connector.arcanada.ai.conf  /etc/nginx/sites-enabled/connector.arcanada.ai.conf
  ln -sf /etc/nginx/sites-available/connector.arcanada.one      /etc/nginx/sites-enabled/connector.arcanada.one
  nginx -t && systemctl reload nginx   # graceful, no dropped connections
'
```

> The live `.one` host file is named without a `.conf` suffix
> (`/etc/nginx/sites-available/connector.arcanada.one`); the repo copy carries
> `.conf` for consistency. Mind the scp target name above.

TLS certs (`/etc/nginx/ssl/wildcard.arcanada.ai.*`, `connector.arcanada.one.*`) are
**not** in this repo — they come from Vault (`arcanada/shared/ssl/...`) per the
project CLAUDE.md § Deploy & Creds.

## Drift check (host vs repo)

```bash
ssh root@65.108.236.39 'cat /etc/nginx/sites-available/connector.arcanada.ai.conf' \
  | diff - deploy/nginx/connector.arcanada.ai.conf && echo "in sync" || echo "DRIFT — reconcile"
```

Any host-side hotfix MUST be back-ported here in the same change so the mirror stays
authoritative. (Header block in each `.conf` repeats this rule.)
