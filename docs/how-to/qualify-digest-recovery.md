# Qualify digest recovery before app cutover

This procedure qualifies recovery for the existing Muneral and assistant
services. It grants no access and performs no automatic install, backup,
database restore or deployment. Resolve the production/database hosts and
protected credential references from the existing inventory and custodians.
Operational permissions are managed through the admitted runtime API, never a
repository expiry edit.

## Bind the exact recovery candidates

Record the current full container IDs, immutable image IDs, compose project,
service, complete config-file list, start times and health. Bind each proposed
forward and rollback image to independently received source/build evidence;
checkout HEAD alone does not identify a running image.

Before build or cutover, qualify the existing stock broker generation and its
retained prior code, pinned helper and sudoers. The reviewed install-only main
route is `model-connector sync <admitted main SHA>` followed by
`model-connector run-deploy`; its tracked request and source hashes are reviewed
main content, not runner environment or arbitrary stdin. A source-only review
does not authorize that invocation.

The admitted broker's build for `muneral` and `arcanada-assistant` snapshots the
healthy old image through the stock `tag-rotate` operation. Require exact
`:previous` image and protected recovery-record readback before `up`. A missing
record/tag or identity mismatch blocks cutover. Do not create a substitute
receipt or tag by hand.

## Qualify authorization compatibility separately from health

The rollback candidate must either read the current runtime grant store and
revocation generation or deliberately deny the digest. Prove these outcomes
against the exact candidate using the existing admitted isolated HTTP/database
fixture: absent/revoked/expired permission, revoked/expired key, disabled
principal, wrong workspace and unavailable store must deny without private text.
An earlier observed `403 GRANT_EXPIRED` for an old source-list image proves only
that observation; it does not prove runtime-store compatibility.

The new source must reject legacy grant-object arguments and check authenticated
key/principal/grant rows in the same transaction as the metadata SELECT and
audit. Receive the actual source/import/image bindings and rollback fixture;
method names, JSON booleans or a healthy `/health` are insufficient.

Keep the additive permission schema, current grant/revocation state, append-only
mutation history and audit data when rolling back application code. Do not run
a down migration, restore an older live database, seed an active permission,
fall back to a static list, or renew a grant through Git. If the selected older
app cannot preserve that boundary, select a reviewed deny-only compatible image
or hold cutover; do not relax authorization to preserve digest availability.

## Receive the actual backup source and format

Identify the registered backup mechanism on the database host, not just a
successful backup unit on the app host. `LoadState=not-found` with a default
`Result=success` is not a backup success. Bind the original script/config/cron,
actual source database/cluster, repository, full snapshot ID, completion time,
included object path, format and age. Obtain repository metadata only through
the incumbent protected credential route, without new login or printed secrets.
No snapshot ID or dump path may be invented from this runbook.

Check the actual format before choosing the restore command:

| Actual producer | Receiving and isolated restore |
| --- | --- |
| `pg_dump -Fc` custom archive | `pg_restore --list` checks the archive; a separate complete isolated restore still must pass. |
| `pg_dumpall` plain SQL, optionally gzip-compressed | Verify compressed-file integrity when applicable, then restore the SQL using `psql -X -f` in an admitted empty isolated PostgreSQL cluster. `pg_restore --list` is the wrong format receiver. |

`pg_dumpall` includes cluster-global objects and multiple databases. Do not
extract a database by an improvised text filter or send the cluster SQL to live
PostgreSQL. SQL restore executes source-selected statements and possibly psql
meta-commands; use the existing reviewed isolation and source trust boundary.
Gzip integrity, a snapshot listing and a command exit are each narrower than a
verified service restore.

After the existing custodian has supplied exact snapshot/path/custody and the
isolated resource plan has passed, the supported operations are:

```sh
# Protected environment and these identifiers come from the admitted custodian.
# No credential value belongs in argv, source, stdout or the public receipt.
restic --no-cache --no-lock snapshots --json --group-by host --latest 1
restic --no-cache --no-lock restore "$SNAPSHOT_ID" \
  --target "$OWNED_SCRATCH_DIR" --include "$SNAPSHOT_OBJECT_PATH"

# For the original compressed SQL-stream format only, inside approved scratch:
gzip -t "$OWNED_COMPRESSED_SQL"
# The existing receiving executor supplies the exclusive retained output FD.
gzip -dc -- "$OWNED_COMPRESSED_SQL" >&"$OWNED_SQL_FD"
psql -X -h "$OWNED_PG_SOCKET" -p "$OWNED_PG_PORT" \
  -U "$OWNED_PG_RESTORE_ROLE" -d postgres -f "$OWNED_SQL_FILE"
```

These are not commands to execute with unbound variables. The decompressed file
must be created with the existing protected-ancestor/O_EXCL/retained-FD sink
contract and read back as the same inode before `psql`; a mutable shell pathname
redirect is insufficient. Require the same
existing owned resource/capacity/timeout/cleanup contract used by the receiving
owner; do not allocate another full run. Keep private SQL and restore diagnostics
inside protected scratch. Publish only source/snapshot/format hashes, times,
sanitized outcomes and cleanup identities. Restore may return expected
cluster-global conflicts; receive the full outcome explicitly instead of
turning an unexplained nonzero exit into success or silently skipping errors.

The restored service must pass schema compatibility, same-grantee metadata and
negative authorization checks. A service-specific snapshot and isolated restore
receipt are required; app-host generic backup success or an old sample check
does not close database coverage.

## Execute only the admitted app recovery

For a qualified cutover failure, invoke the existing stock broker's
`<service> rollback`. It rebinds current identity and the protected old-image
record, then recreates only the named app service with
`--no-deps --no-build --pull never`. Receive the full resulting container/image
identity, health and denial predicates. Preserve all data volumes and runtime
grant/audit state. Do not restore the old broker generation while app recovery
still requires its new recipes.

Reverse or hold on unknown backup coverage, mismatched format/source/image,
missing recovery custody, unqualified issuer or source gate, a revived static
permission, lost revocation, private field exposure, or unowned resources. An
uncertain action requires owned reconciliation; it is not permission to repeat
an install or restore.

## References

- [PostgreSQL 16 pg_dumpall](https://www.postgresql.org/docs/16/app-pg-dumpall.html)
  describes SQL-script and cluster-global output and its restore trust boundary.
- [PostgreSQL 16 pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)
  applies to supported non-plain archive formats.
- Stock source: `deploy/broker-install-main.sh`,
  `deploy/install-arcanada-compose-broker.sh` and
  `deploy/arcanada-compose-broker.sh`.
