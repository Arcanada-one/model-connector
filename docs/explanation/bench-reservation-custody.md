# BENCH reservation custody source kernel

This change supplies an unwired reservation kernel for the native subscription benchmark. It does not import the kernel into AppModule, expose a route or Unix listener, issue grants, load credentials, migrate a running database, call a provider, or enable a campaign. Existing commercial BillingService and Assistant API-key authorization remain separate.

## Financial and identity boundary

The immutable campaign ceilings are 528 attempts, 10,000,000 input tokens and 1,500,000 output tokens. The retained baseline is at least 180 attempts, 1,695,917 input and 199,911 output tokens. A signed bootstrap pins the original ledger hash and original lineage. It inserts once; changing campaign or journal identifiers cannot reset that lineage. These subscription counters are not USD credits, payment intents or refunds.

An issuer-signed grant binds account, caller subject, Auth Arcana audience and public JWKS digest, provider, model, source and binary hashes, bounds evidence, retained baseline, journal and the distinct custody signer. RS256 Auth Arcana identity verification checks issuer, audience, subject, fresh issue time, expiry and the reserve or separate provision scope. Synthetic fixture keys and scopes are source tests only; no deployed IAM entitlement is asserted. Grant expiry of at most one hour and caller freshness of five minutes are proposed source policies, not historical product requirements.

## Commit order and unknown outcomes

CampaignStore and CheckpointStore use the existing PostgreSQL driver. SQL row locks and a conditional compare-and-append implement the specific atomic boundary; Prisma describes the new primary tables. Both stores require synchronous commit and fsync, different database names, different actual non-superuser roles. These queries do not prove independent production hosts, administrators, backup custody or signer isolation.

The primary campaign row is locked and its complete immutable reservation chain is checked. The separate checkpoint compares the exact previous head, commits the next reservation and immutable event first, and consumes allowance without release. Only then can the primary append and commit. The custody signature is produced after both commits. A lost response spends; a failed primary insert or deferred commit after checkpoint commit leaves mismatching heads and freezes future attempts. No retry can manufacture a refund or second permit. A failed checkpoint commit grants nothing.

Primary restore, checkpoint head restore, missing rows, corrupt chains, duplicate attempts and nonce replay are tested against real isolated PostgreSQL, including six competing OS processes. Joint restoration of both independent authorities and physical power-loss durability are NOT_MEASURED. Runtime ownership and restoration procedures must prevent a common rollback of both authorities.

## Native integration prerequisite

The separate native source patch uses a signed NativeBenchAdmission/v1 and fresh signed NativeBenchReservationRequest/v1 receipt at its actual HTTP send boundary. The grant fields and signature domains are shared with this kernel. There is currently no trusted socket-to-service adapter: the native socket request contains reservation data, while this service also requires a verified grant and authenticated caller. Root must review and provide an adapter that binds these inputs without trusting caller-supplied identity, plus measured issuer/signer/database custody, genuine bounds and prior unknown-consumption admission. No public listener or ambient token fallback is supplied here.

Root owns integration, graph admission, blind review, deployment and runtime decisions. Activation is refused until those independent prerequisites pass; this source kernel alone is not runnable BENCH authority. Reverse by removing only the new unwired module and private native build; retain the original campaign, commercial billing, all unknown reservations and existing workers.

## Reproduce source checks

Use frozen package-lock inputs and an explicitly owned PostgreSQL fixture cluster with TCP disabled, socket directory mode 0700, and separate non-superuser primary/checkpoint writer roles. Set BENCH_OWNED_TEST_PG_SOCKET to the owned fixture socket and use vitest.bench-reservation.config.ts. This configuration includes only the two BENCH source suites, never provider-facing integration fixtures. The fixture schema recreation and fault triggers are restricted to these disposable databases. Use an owned writable TMPDIR and disable Node compile caching on hosts whose default temporary directory is broken.

Prisma schema generation, TypeScript checking, formatting, exact test logs and source custody receipts are separate gates. Neither these local checks nor a draft PR imply green remote CI, deployment, provider execution or a product result.
