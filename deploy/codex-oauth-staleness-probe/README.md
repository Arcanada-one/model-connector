# codex-cli OAuth staleness probe (CONN-0218)

Daily read-only check of the codex-cli OAuth blob's age in Vault
(`arcanada/prod/env/codex-cli`), alerting Ops Bot before the token looks
stale enough to fail — instead of finding out reactively from a live
401/execution_error (CONN-0072, CONN-0217 both surfaced this way).

Script: `../../scripts/codex-oauth-staleness-probe.sh`. Tests:
`../../scripts/codex-oauth-staleness-probe.test.sh`.

| File | Purpose |
|------|---------|
| `codex-oauth-staleness-probe.service` | oneshot systemd unit — runs the probe once |
| `codex-oauth-staleness-probe.timer` | daily trigger (±30min jitter, catches up if the host was down — `Persistent=true`) |

## Not yet installed on PROD

This is IaC-authored only (CONN-0218 backlog sweep). Installing requires:

1. **Provision a read-only AppRole** for this probe (or reuse the existing
   codex-sidecar-entrypoint.sh read role — least-privilege argues for a
   dedicated role scoped to `read` on `arcanada/prod/env/codex-cli` only,
   no write). Vault provisioning is a hard-gated action, not done here.
2. Create `/etc/arcanada/codex-oauth-staleness-probe.env` on arcana-prod:
   ```
   VAULT_ADDR=https://vault.arcanada.one:8200
   VAULT_ROLE_ID=<probe-read-role-id>
   VAULT_SECRET_ID=<probe-read-role-secret-id>
   OPSBOT_API_KEY=<ops-bot-bearer-key>
   ```
3. `scp` the two unit files to `/etc/systemd/system/`, then:
   ```bash
   systemctl daemon-reload
   systemctl enable --now codex-oauth-staleness-probe.timer
   ```
4. Verify: `systemctl start codex-oauth-staleness-probe.service && journalctl -u codex-oauth-staleness-probe -n 20`

Steps 1–4 are prod-deploy + secret-provisioning actions — authored here,
not executed, per hard-gate policy.

## Thresholds

`--warn-days 10` / `--crit-days 14` (script defaults) — matches the two
prior-incident cadence noted in the CONN-0218 backlog entry. Override via
`--warn-days`/`--crit-days` flags in the `ExecStart` line if the operator
wants a different cadence.
