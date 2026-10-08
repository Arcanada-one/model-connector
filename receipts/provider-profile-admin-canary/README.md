# Dedicated provider profile admin route canary

Measured source: `3b26285b6f40c3f8d825d0eb24283bc3c15b11c5`.

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

The rebased default suite passed 3654 assertions, with four existing skips, across
241 files. This canary covers only the two added routes; inherited graph findings
retain their own tri-valued status. Full native change admission is reported
separately and is not implied by this record.
