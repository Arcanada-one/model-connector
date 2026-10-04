# Billing atomic deployment prerequisite

This source prepares an opt-in transaction. Billing has no service-table row;
all Billing invocations still refuse before helper execution. There is no first
installation, canonical registry admission, credential issuance, migration or
payment activation here. Existing service actions retain their current behavior.

After separate source admission, reviewed root bundle installation and registry
binding, Billing callers may use only `atomic-check <main-sha>`,
`atomic-deploy <main-sha>` and `atomic-recover <transaction-id>`. A private lock
covers the entire root transaction. The fetch credential arrives on bounded
stdin, reaches Git only through root process environment, and never reaches
Docker argv/environment or diagnostic output. No environment file is evaluated.

The baseline must already have an exact checkout revision, private `.env`,
matching OCI image revision, running healthy Docker container and HTTP health.
A stale `:latest` refuses. Successful exact Docker image listing may prove
`:latest` missing; only the verified actual installed image supplies its baseline.
No healthy installed baseline means refusal, including first installation.

Git stages the fixed Billing repository and refuses commits not reachable from
origin/main. A protected environment copy lives beside the staged compose file.
The current checkout is preserved whole, including compose and the old `.env`.
After a protected, fsynced write-ahead journal, Linux `renameat2(RENAME_EXCHANGE)`
atomically switches checkout directories. Build/up/health failure restores that
checkout and the actual original image, then verifies the restored service where
up was attempted. No database volume is owned, mounted, changed or removed.

Interrupted or failed recovery retains the journal and rejects another deploy.
Recovery requires the exact active transaction ID, safe root paths and matching
old/new directory inode pair. Unknown custody, mount boundaries, unsafe files,
changed ownership and symlinks refuse; there is no guessed state reset. Protected
baselines and old helper generations remain retained. A process killed outside
this protocol is not automatically claimed healthy: the root owner must use the
receipt-bound recovery and collect an actual runtime receipt.

Every native operation after journal creation has a durable pending record before
invocation and a separate completion write after a returned result. A timeout,
interrupt, process kill or failed completion write cannot mean that the daemon
finished. Pending operations block both a new deploy and recovery, including a
pending recovery operation under a previously committed transaction. The source
has no genuine completion/quiescence evidence issuer for such unknown outcomes;
there is no receipt-ID override, state reset or claim that a caller process exit
settled a daemon. A separately reviewed owner completion mechanism is a remaining
source prerequisite before this class of recovery can be enabled. Ordinary
returned failures can restore the baseline; unknown outcomes retain their WAL.
Completion publication uses a separate state copy: a one-shot persistence failure
cannot replace the in-memory pending guard before recovery. Health probes propagate
typed unknown outcomes immediately, without retrying or converting them to ordinary
health failure; the transaction retains its pending health invocation.

The installer remains root-only and outside runner sudo. It verifies the helper
and unchanged sudoers hashes bound inside the expected broker, installs a private
content-addressed helper first, preserves the old broker, and publishes the new
broker last. `install-arcanada-compose-broker.sh --restore <old-broker-sha256>`
restores that protected old code atomically without altering sudoers or services.
Install/restore require a reviewed maintenance fence with no active Billing
transaction; these commands do not establish that runtime fence themselves.

Tests use owned disposable paths and fake native adapters, plus real rename,
fsync, process argv and a real subprocess timeout. A controlled late completion
does not clear the native pending record or authorize another operation. The
fixture models production root metadata only for the
unprivileged test namespace; there is no runtime path/UID override. Local tests
and CI are source evidence. Installation, legitimate bootstrap, rollback under
production ownership and live auth remain NOT_MEASURED until executed separately.
