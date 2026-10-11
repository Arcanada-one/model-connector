# C07 Prime rendered Compose receiving contract

Existing task: `00f87fa2-2614-483f-8fab-380b614b7723`; acceptance task: `aa4c78ca-ae17-419b-be40-4bc169f7d52f`.

This source-only checker qualifies configuration equality, not image provenance, source review, runtime admission, port availability, deployment or readiness. It has no Docker/HTTP/credential execution and is not installed by the broker installer. Prime remains outside the broker allowlist in this change. Caller-supplied expectations are test inputs; they never become an actuator authorization.

## Measured receiving failure

Factory main `c5fc6a08008c815a0660036a3bc59660752abbd4` and owner head `1c3ecb1e6b3c2b59603a9a20a83f28983fd4a3aa` contain:

```yaml
tmpfs: [/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777]
```

Docker Compose v5.1.4 renders six list entries: `/tmp:rw`, `noexec`, `nosuid`, `nodev`, `size=16m`, `mode=1777`. The flags are not attached to the `/tmp` entry. The owner must quote the entire mount specification. INFRA does not edit Factory source. The old rendered model is retained as a negative control; the positive fixture was rendered from an isolated copy with only that quoting correction, using synthetic digest `a` repeated 64 times and port 18993. Neither value is a qualified release image/port.

Docker's [config command](https://docs.docker.com/reference/cli/docker/compose/config/) resolves variables and renders the model. Its [tmpfs reference](https://docs.docker.com/reference/compose-file/services/#tmpfs) specifies mount paths and options. Rendering success does not prove a container can be created.

## Supported receiving API

Run `docker compose -p prime -f <reviewed Factory compose> config --format json` in a separately deadline-bounded native process, preserving exit code and sanitized stderr. Do not use `--environment`, dump env files, forward raw private configuration or retry a failed provider unchanged. Only after a complete successful capture, supply its bytes on stdin to:

```text
python3 -I deploy/prime-compose-contract.py --expected-image <independently admitted digest reference> --expected-port <independently qualified unused loopback port>
```

The result is always `configuration_only`, `runtime_authorized=false`. Unknown fields, other services/networks, mounts, secrets, environment additions, entrypoints, public ports, privilege changes and altered health/resource controls refuse. Duplicate JSON keys, nonfinite numbers and capture over 65536 bytes refuse without echoing private values. Different Compose canonicalization also refuses; review a source successor rather than normalize unknown fields away.

## Source owner and remaining delivery gate

PRIME owns the immutable image build/publish workflow and Factory compose correction. INFRA owns the broker receiving/rollback route. MC-KEYS confirmed no active overlapping broker hunks in MC203. SECURITY owns credential issuer/consumer custody. No reviewed release manifest, qualified digest or unused port currently exists; inventing them would cross the authority boundary. The checked skeleton is process-health-only and cannot substitute for a running worker.

Before broker registration/activation, the existing owners must bind: reachable reviewed Factory source, independently read image digest and source-revision identity, current CAR/review/CI, host/port resources, required native scope and owned rollback. The real work-loop/service admission is separate from this health-only config check. No new workflow/job, grant, paid capacity or provider call is introduced.

## First-install rollback source conditions

Prime has no prior live image. A first install cannot claim `:previous` recovery. Before its one activation, the stock successor must durably record a complete owned-project absence baseline and bind the actual newly created container ID, expected image/config/source and Compose project/service labels. Rollback must recheck that exact ID and custody before stopping/removing only the owned `prime/health` container; preserve images, volumes, networks, shared Alloy and foreign containers. Changed/missing/ambiguous identity or custody refuses. Future releases require an exact previous admitted image/config snapshot.

This is a source contract, not an implemented or measured runtime rollback. Docker [compose rm](https://docs.docker.com/reference/cli/docker/compose/rm/) can remove service containers and `-v` removes volumes; therefore no unqualified project-wide `down`, volume-removal flag or foreign service wildcard is accepted as first-install rollback. The operational receipt must independently prove restored owned absence and neighboring health before release acceptance.

## Evidence gate and reverse_if

Source decision requires independent PRIME correctness and SECURITY exposure review, exact-head CAR/stock gate and hosted checks. Targeted controls execute the actual helper and independent native-rendered fixtures; no global heavy suite is substituted for admission. Runtime remains NOT_MEASURED.

Reverse/revise this source checker if it accepts a widened rendered service, exposes raw private input or labels configuration proof as deployment authority. A future actuator must stop/revert only through reviewed owned custody; this checker never signals a process or changes runtime. Source rollback is a reviewed revert of these newly added files; no existing broker route is changed.
