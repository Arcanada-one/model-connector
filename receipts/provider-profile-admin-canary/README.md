# Dedicated provider profile admin route canary

Measured source: `863c635805924b5a8d92fcc1a781ff8e1d0500e5`.

The source was clean, built with the normal Nest build, and loaded into an owned
loopback Nest application containing the production AdminController, AdminService,
AdminGuard and PrismaService. PostgreSQL was disposable, using a private Unix
socket. No service database, shared listener, provider credential or upstream call
was used. SOURCE.json records source/tree identity and loaded artifact digests.

The stock graph deploy_gate.py producer does not support the admin token header.
Its PLAN.json / RESULT.json measure actual route presence and unauthenticated
403 refusal for the two new GET routes. AUTHENTICATED.json records four separate
200 observations with the admin header, assertions of profile A/B identity,
client-scoped real-PostgreSQL aggregates (7 versus 97 input tokens), and omission
of key hashes. These observations are test-environment evidence, not production
acceptance, deployment or migration evidence. The harness is
`test/provider-profiles/canary/admin-routes.cjs`; it requires an explicit disposable
database assertion and keeps the listener open until SIGTERM for native probes.

The error redaction regression places a synthetic dedicated credential at all 41
positions 480 through 520 and checks the exact response / Request error message,
plus credential absence in responses, stored rows and captured logs. Before the
fix, 20 offsets (480–499) failed; after the fix all pass. Provider-specific Azure
formatting and Perplexity parsing are covered too. JEV consumes no raw error body.

The strict boundary is a working injected spy. Its legacy positive control returns
200 SSE; a dedicated profile returns exactly `strict_profile_unavailable` with zero
boundary dispatches. Removing only the profile guard yields 200 instead of 503,
so the negative test fails while the legacy control passes. Six original negative
controls (client binding, JEV override, revocation, request cap, redaction and
attribution) also fail when their guards are removed.

The rebased default suite passed 3658 assertions, with four existing skips, across
241 files. PROCESS-PLAN.json / PROCESS-RESULT.json additionally measure both affected provider-specific error code units with compiled-code assertions at all 41 offsets. The native process producer pins the executable, harness and loaded implementation bytes. These are deterministic process observations, not live provider measurements.

The canaries cover the two added routes, two provider error code units and the JEV bounded JSON reader; inherited graph findings
retain their own tri-valued status. Full native change admission is reported
separately and is not implied by this record.

Malformed 2xx JSON is read as complete text and redacted before JSON decoding in
the Base reader and the bounded JEV override. Parse failures use a generic
SyntaxError without a parser excerpt or cause. The HTTP regression creates a
fresh Response on both retries and checks client error, Request.errorMessage and
captured logs. The unchanged Base reader fails with a ten-character credential
prefix; the JEV adapter retains its existing generic outbound error. Direct-reader
controls fail on both old readers. Restoring each unsafe reader makes its test
RED. The process canary also executes both compiled readers against malformed and
valid credential-echo JSON; this is bounded-reader evidence, not qualification of
the separate strict transport or a live supplier.

The authored connector scaffold also uses an actual Response body; its native
README-rendered test execution passes all 21 assertions with mocked transport.
