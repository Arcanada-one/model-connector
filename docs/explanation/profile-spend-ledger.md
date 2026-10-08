# Profile spend admission and accounting

Status: draft slice-two implementation for independent review. The durable
ledger, authenticated event readback and reference envelope have local controls;
strict execute admission remains unwired and its four HTTP controls are RED.
This extends the dedicated credential profile with explicit supplier exposure limits. It does not grant
runtime authority, provide production tariff values, or enable a provider.

## Contract and boundaries

A client keeps one MC key and its existing dedicated credential bindings. Each
allocated provider key gets a stable, opaque **accounting profile ID**; rotation
changes the credential reference/version and retains that accounting identity.
The existing profile accounting bucket identifies the client application's
aggregate spend across providers and credential rotations. API-key ID and
credential identity remain independent columns on each call.

The consumer contract is `urn:arcanada:prime:model-spend:v1`, response discriminator
`PrimeModelSpend/v1`, pinned schema SHA256
`58497c0995c16dcec73ad91e721093b5d3e857c1c61a68059015c55cde14f107`.
Physical call IDs, run IDs, node membership, route `mc`, UTC admission intervals,
policy and tariff revisions survive export. Prime can join its direct history and
MC history by immutable call IDs without changing its accounting semantics.
Supplier-billed cost, tariff-derived cost and conservative exposure are distinct.
Missing usage or supplier invoices stays null; uncertainty is `NOT_MEASURED`.
One call containing several nodes counts once; node-level batch costs/tokens
remain null with `shared_batch_not_apportioned` attribution.

Strict **spend admission** is a policy mode. The existing streaming strict-chat
boundary still requires its own qualified transport integration. This slice
must not remove its dedicated-profile refusal to enable an unqualified route.

## Approaches considered

Post-call Request sums cannot stop concurrent calls overshooting a cap and lose
unknown attempts. Redis-only counters cannot establish durable exposure across
crashes or reconcile policy/UTC changes. Use an append-only PostgreSQL supplier
ledger and short transactions serialized by a stable client/accounting identity.
Reuse the existing API auth, fresh policy reads, registered credentials, billing
fingerprint, additive migrations and ordinary service choke point. Customer
credits/holds remain a separate ledger; releasing a customer hold does not
release supplier exposure.

## Policy and arithmetic

An optional versioned `spend` block on a version-two key policy enables strict
admission. Existing keys without the block retain existing behavior. The block
requires explicit effective interval, immutable policy version, currency, client
run/day/month limits and concurrency, plus provider accounting profiles with
explicit day/month caps and immutable, time-bounded model tariffs. Missing,
malformed, stale or unavailable configuration refuses before egress. Zero is a
valid cap that permits no positive exposure. There is no permissive cap default.

Use decimal strings at the policy boundary and fixed-point integer arithmetic
internally (nine fractional currency digits). Round reservations conservatively
upward; never use floating-point equality in admission. Initial supported money
is explicitly USD, matching MC's current pricing boundary. Other currencies
refuse; no implied conversion. The read-only numeric contract is a serialization
boundary and refuses unrepresentable amounts instead of silently rounding.

Tariffs snapshot an exact provider/model identity, revision, input/output prices,
validity and source reference. The mutable Float catalogue and its unknown-price
fallback are insufficient strict authority. A configured zero tariff remains a
known zero; an absent tariff is unknown. Cached/reasoning token discounts are
used only when actually observed and pinned; otherwise conservatively price the
full input/output counts. Preserve the original observation.

Reservation uses a qualified server-side maximum input bound and the bounded
output ceiling actually sent on the wire. A client-provided estimate cannot lower
it. Reject unbounded/multimodal/output-repair requests and automatic paid retries.
Each strict intent can cause at most one physical upstream attempt. A provider
whose finite upper bounds are unqualified refuses before egress; ordinary JEV
currently needs output-bound qualification. Synthetic fixtures can qualify the
control, but they do not qualify a live provider or supply a live tariff.

## Durable admission and state

1. Authenticate and re-read active policy/credential membership. Validate the
   model, tariff, finite request bounds and run/node accounting context. Require
   a bounded idempotency key; bind its fingerprint to provider, model, payload,
   run and node membership. Strip accounting context before the provider body.
2. In one short transaction, lock the stable accounting identity, re-check the
   immutable policy binding, and insert/read the unique call intent. Same intent
   and payload returns its existing state; a changed payload conflicts. Check
   every profile/client/run/day/month cap and concurrency against existing
   conservative exposure plus the new reserve. A cap refuses with HTTP 429 and
   zero upstream calls. DB failure refuses; no memory-only admission.
3. Commit reservation and an append-only reservation event. Claim once, then
   durably mark possible egress immediately before the real HTTP dispatch. Do
   not keep a DB transaction open during network activity. An ambiguous commit
   or claim never permits a resend.
4. Observe raw provider usage/model/request identity before legacy adapters can
   coerce unavailable fields to zero. Append observation and tariff cost, preserving
   nullable usage. Exposed cost remains `max(reserve, observed tariff cost)` until
   independently reconciled. It is not reserve plus observed cost. Above-bound
   usage, model substitution or entitlement failure pauses the profile; all
   errors halt the affected run and retain exposure.
5. Crashes/timeouts/missing usage leave an uncertain call with held exposure and
   concurrency. Only independently evidenced zero-egress/zero-charge or approved
   reconciliation can append a release/reduction. No TTL or midnight refund.

Historical calls retain their admission UTC day/month. Current-period safety
checks also include older unresolved exposure exactly once. A new policy version
or lower cap cannot erase held exposure. Credential/key rotation cannot reset the
accounting bucket. Threshold crossing at 80 percent inserts a unique outbox entry
in the same reservation transaction; failed notification remains pending. This
slice may record the outbox without sending messages.

## Consumer readback

The machine-authenticated projection scopes every query to the requesting client
and validates half-open UTC windows (at most 186 days) and opaque profile/node
filters. Preserve at least six calendar months including retired profiles.
Unknown intervals are coverage gaps, not zero-call days. Export the pinned
contract's profiles, physical-call totals, nullable usage/cost, daily series,
by-node attribution, caps/exposure/threshold state and reconciliation status.
Supplier reconciliation remains separately evidenced; absence of that evidence
is `NOT_MEASURED`. No raw prompts, answers, private bodies, credential paths,
credential values or key hashes appear in the projection.

Migration joins receipts into Prime's existing ledger, fences direct admission,
carries outstanding exposure, and switches a single route owner. It does not
move or replace Prime's historical database. Cutover and retirement require
separate live evidence; the interim direct route remains available meanwhile.

## Implementation sequence and falsifiable controls

- First validate the explicit policy shape and add real HTTP negative tests with
  a working legacy/dedicated positive control. A zero cap on the current ordinary
  service must fail the expectation if spend admission is absent: 201/one fetch
  instead of 429/zero fetches. Unknown/stale tariffs and unqualified bounds must
  similarly fail their zero-egress expectations on the ungated path.
- Build exact-money/UTC primitives and durable SQL ledger. Real disposable-PG
  tests race concurrent clients against profile and aggregate day/month/run caps,
  test duplicate claims, crash/ACK loss, paused runs and threshold deduplication.
  Removing atomic serialization must let a race violate its measured cap.
- Wire one strict ordinary attempt and raw usage observation; test actual adapter
  Authorization/bounds, no retries, model mismatch, null usage, above-bound cost,
  timeout and DB failure. Remove each guard individually and require RED, while
  its positive control stays green. Existing shared-key behavior stays green.
- Add a bounded safe projection and validate it offline against the exact pinned
  consumer schema; test unknown history, duplicate call IDs, overlapping nodes,
  filtering, currency refusal and query limits. Removing client scoping must
  expose a foreign fixture and make the negative test RED.
- Additive schema/migration validation, full default checks, committed source-bound
  canaries and unmodified graph admission follow. Independent exact-head review
  precedes release. No live provider is needed for these synthetic controls.

Evidence and test state belong to the existing work item and durable review
bundle. This design is not a passing test, production acceptance or spend grant.

## Prime parity gates (ROOT 2026-10-08 16:30 UTC)

R1 and R2 remain contract gaps: the measured conservative MC exposure differs
from Prime settled exposure and its UTC treatment of completed, unreconciled
calls. No implicit reconciliation or exposure reduction is permitted. A reviewed
shared representation must make headroom, threshold alerts and next-call decisions
match while retaining unknown exposure exactly once.

R3 uses a stable logical identity `(account, run, intent)`, independently of the
client API-key identity. A rotated key replaying an existing logical intent must
refuse without another reservation or dispatch; changed payload must conflict.
The original key and upstream credential references remain attribution on the
original physical attempt. Tests must use generous caps so a budget rejection
cannot conceal a missing replay guard. Service and importer parity remain separate
acceptance gates; store tests alone do not permit Prime cutover.

The stable owner profile is bound to one durable accounting bucket. Rotating a
client key cannot bind that same owner to a new bucket and erase exposure. A
unique owner constraint serializes first binding even across competing buckets;
a conflicting binding refuses before reservation or dispatch. A deliberate
account migration would require its own reviewed transfer of retained exposure.

## Consumer mapping clarification (PM05 ACK_CONCEPT_ONLY, 16:49 UTC)

For MC-route calls, the proposed mirror keeps observed tariff metrics separate
from authoritative MC held cap exposure. Two reservations of 100 with observed
cost 10 each mean tariff metrics 20 and held exposure 200; both MC and its future
Prime mirror refuse a further reservation of 100 under a 250 cap. This preserves
the existing conservative MC rule. It does not reinterpret Prime direct history.

The Prime-wide envelope must combine direct history and distinct MC physical
attempts without counting mirror copies twice. A client cap is not automatically
Prime's global cap. Export requires authenticated policy/scope/interval, original
admission UTC, monotonic event/cursor identity, outbox provenance and an explicit
registry of the budget authority. Existing internal prime_currency keys must not
be exported as ambiguous global authority rows.

Completed calls with reconciliation NOT_MEASURED retain held exposure across UTC
periods exactly once, as do uncertain calls. Their observed usage remains on the
original admission date. Missing invoices, balances, stale imports or missing
receipts do not release exposure; rollback must preserve it. The common envelope
API/schema, importer and integrated comparator remain open gates. Consumer ACK
is conceptual only and grants no release, deployment, provider use or cutover.

## Independent R1/R2 importer controls (2026-10-08)

The candidate reference adapter requires an explicit route and call state for
baseline holds. A settled direct call keeps its original UTC attribution even
when supplier reconciliation is NOT_MEASURED; invoice uncertainty alone must
not carry settled direct tariff cost into every later period. Uncertain direct
holds and MC unreconciled reservations retain their conservative carry separately.
Physical identity deduplication retains the stronger carry basis of both copies.

Every imported attempt must hold at least its reservation and any reported
observed cost on the first page as well as subsequent pages. Invalid receipts
pause admission and retain all previously imported exposure. These controls do
not establish tariff arithmetic, capability/bounds qualification or Prime's
persisted importer; those common-interface acceptance gates remain open.
