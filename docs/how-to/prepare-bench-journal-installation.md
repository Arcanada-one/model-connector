# Prepare the disabled original-Journal installation manifest

This is a source-only preparation procedure, with no live installation or financial
admission. `deploy/bench-monetary-v2.disabled.json` binds receiver709 and the reviewed
Billing3a fifteen-module source artifact. The original API is `Journal` with
`custodian.reserve_atomic`; use its original schema and single-store UNKNOWN ledger.
The fixture-only Python entrypoint is not an authenticated executor.

Run from this repository without credentials or provider environment:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B deploy/bench-monetary-manifest.py
```

Exit2 and `NOT_MEASURED` are expected: the dry-run emits only missing reference
names, never reads references, installs files, starts a process/socket, or opens a
Journal. Supplying nonempty IDs does not authenticate them; activation still refuses
until the incumbent authority supplies and verifies the real tuple. Enabled,
fixture-selected, changed-source and changed-module manifests refuse. There is no
install/bootstrap/activate switch. Do not wire this preparation into AppModule or CI
deployment. Run the offline controls separately:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B deploy/tests/test_bench_monetary_manifest.py
```

## Missing incumbent custody

Existing Security/Root identity custody must supply protected references and genuine
receipts for the original caller subject/audience/JWKS, campaign/account/provider/model,
grant issuer, distinct custody signer, policy/bounds proof issuer, current revocation
and enforceable native hard output maximum. Existing Billing custody must supply the
original Journal path/device/inode/OS ownership and independently trusted current
head/checkpoint. Infra needs the authenticated executable/source/binary and OS executor
tuple plus an explicitly owned0700 version staging leaf. All references remain null
until supplied by their legitimate existing custodians. General SSH, deploy-env and
provider AppRole references confer none of this authority.

The later authenticated executor must verify the complete fixed tuple and current
authority before and after each durable publication under the original Journal lock.
It must use an integer live clock and the minimum of grant, caller, operation,
start+5 and both proof expiries. An expected-body equality callback, process timeout,
stdout limit or declared token number cannot replace authentic admission or a native
output bound. Requests/wire/proofs/deadline stay on stdin; independent custody stays
on privateFD3. No shell, inherited provider environment, retries, bootstrap, v1
fallback or second ledger is permitted.

## Later reversible code staging boundary

No staging is executed by this source change. After authentic authority and independent
source review, a separately scoped native installer can verify exact source/binary
pins and OS identity, create only a new explicitly owned0700 version leaf, publish an
exclusive version pointer, and record every created file/mode/hash. Refuse preexisting
foreign paths and symlink escapes. Never provision an original Journal or copy it into
a second authority. A failed publication must preserve the previous code pointer.
Rollback restores only that owned pointer/code, after proving child-process custody;
it never rewinds Journal bytes/head/checkpoint, RESERVED/UNKNOWN liabilities, consumed
floors, accounts or keys. Unconfirmed child termination remains UNKNOWN and prevents
a replacement invocation. All earlier source and failed execution receipts remain.

The current manifest grants no provider request, key creation, installation or paid
activation. Original528/10M/1.5M ceilings,180/1695917/199911 floors and USD1 remain.
