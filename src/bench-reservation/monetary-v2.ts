import { createPublicKey, KeyObject } from "node:crypto";
import { z } from "zod";
import {
  CAPS,
  counters,
  grantSchema,
  requireBench,
  sha256,
  checkGrant,
  BenchRefused,
} from "./contract";
import { wireSchema } from "./wire-schema";
import {
  callerDeadline,
  canonical,
  digest,
  signed,
  verifyCaller,
  verifyEnvelope,
} from "./signatures";

const count = z.number().int().nonnegative().safe();
const units = z.tuple([
  z.literal("attempts"),
  z.literal("qualified_utf8_bytes_input_token_upper_bound_charge"),
  z.literal("qualified_model_output_token_upper_bound"),
]);
const monetaryBinding = z
  .object({
    schema: z.literal("NativeBenchMonetaryBinding/v1"),
    policy_sha256: sha256,
    bounds_sha256: sha256,
    expected_head_sha256: sha256,
  })
  .strict();
export const monetaryGrantSchema = grantSchema
  .extend({
    schema: z.literal("NativeBenchAdmission/v2"),
    accounting_schema: z.literal("NativeBenchAccounting/v2"),
    reserved_units: units,
    monetary: monetaryBinding,
  })
  .strict();
const identity = z.string().min(1).max(256);
const moneyRequest = z
  .object({
    campaign: identity,
    account: identity,
    provider: z.literal("chatgpt-subscription"),
    model: z.literal("gpt-6-luna"),
    source_sha256: sha256,
    binary_sha256: sha256,
    journal_id: identity,
    original_ledger_sha256: grantSchema.shape.original_ledger_sha256,
    attempt: identity,
    nonce: sha256,
    wire_sha256: sha256,
    policy_sha256: sha256,
    bounds_sha256: sha256,
  })
  .strict();
export const monetaryRequestSchema = moneyRequest
  .omit({
    policy_sha256: true,
    bounds_sha256: true,
    original_ledger_sha256: true,
  })
  .extend({
    schema: z.literal("NativeBenchReservationRequest/v2"),
    subject: identity,
    accounting_schema: z.literal("NativeBenchAccounting/v2"),
    reserved_units: units,
    wire_utf8_bytes: count.positive(),
    input_token_upper_bound: count.positive(),
    input_policy: grantSchema.shape.input_policy,
    output_policy: grantSchema.shape.output_policy,
    bounds_proof_sha256: sha256,
    reserved: counters,
    caps: counters,
    retained_baseline: counters,
    monetary_request: moneyRequest,
    monetary_checkpoint_head_sha256: sha256,
  })
  .strict();
export const monetaryEnvelopeSchema = z
  .object({
    schema: z.literal("NativeBenchCustodyEnvelope/v2"),
    signed_grant: z.unknown(),
    caller_access_token: z.string().min(1).max(16384),
    request: monetaryRequestSchema,
    operation_deadline_unix: count,
    wire_utf8: z.string().max(10_000_000),
    charging_policy_utf8: z.string().min(1).max(65536),
    wire_bounds_utf8: z.string().min(1).max(65536),
  })
  .strict();
const proofScope = moneyRequest
  .omit({
    attempt: true,
    nonce: true,
    wire_sha256: true,
    policy_sha256: true,
    bounds_sha256: true,
  })
  .extend({ not_before: count, expires: count });
const rate = z.tuple([count, count.positive()]);
const policySchema = proofScope
  .extend({
    kind: z.literal("charging-policy"),
    currency: z.literal("USD"),
    scale: count.positive(),
    mode: z.enum(["metered", "subscription_no_incremental_charge"]),
    money_cap: count,
    money_floor: count,
    retained_counters: counters,
    baseline_head: sha256,
    input_rate: rate,
    output_rate: rate,
    fixed_fee: count,
    no_overage: z.literal(true),
    no_fallback: z.literal(true),
  })
  .strict();
const boundsSchema = proofScope
  .extend({
    kind: z.literal("wire-bounds"),
    wire_sha256: sha256,
    input_upper: count.positive(),
    output_upper: count.positive(),
    context_limit: count.positive(),
    output_enforcement: z.literal("verified_native_hard_maximum"),
    all_billable_units: z.literal(true),
  })
  .strict();
const moneyReceipt = z
  .object({
    schema: z.literal("NativeBenchMonetaryReservation/v1"),
    request: moneyRequest,
    currency: z.literal("USD"),
    scale: count.positive(),
    cap: count,
    floor: count,
    previous_money: count,
    cost: count,
    next_money: count,
    counters_before: counters,
    previous_head_sha256: sha256,
    head_sha256: sha256,
    projection_binding_sha256: sha256,
  })
  .strict();
const receiptSchema = z
  .object({
    valid_until_unix: count,
    request: monetaryRequestSchema,
    sequence: count,
    aggregate: counters,
    previous_head_sha256: sha256,
    head_sha256: sha256,
    durable_verdict: z.literal("ATOMIC_FSYNC_RESERVED_UNKNOWN_NO_RELEASE"),
    monetary: moneyReceipt,
  })
  .strict();
// Match incumbent Python json.dumps(sort_keys=True, separators=(',', ':'),
// ensure_ascii=True), including UTF16 surrogate pairs; never reinterpret proof bytes.
export const monetaryCanonical = (value: unknown): string =>
  canonical(value).replace(
    /[^\x00-\x7f]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
export type MonetaryAtomicInput = Readonly<{
  request: z.infer<typeof monetaryRequestSchema>;
  policy: z.infer<typeof policySchema>;
  bounds: z.infer<typeof boundsSchema>;
  wire: string;
  charging_policy_utf8: string;
  wire_bounds_utf8: string;
  deadline_unix: number;
  assertFresh: () => void;
}>;
/** Incumbent executor must perform ONE durable money+token append under its
 * existing journal lock/CAS, preserve UNKNOWN on every ambiguous outcome and
 * reject nonce/attempt replay. This interface is not an implementation of it. */
export type MonetaryV2Dependencies = {
  issuerPublicKey: KeyObject;
  custodianPrivateKey: KeyObject;
  authArcanaJwks: string;
  now: () => number;
  socketPath: string;
  verifyProof?: (
    kind: "charging-policy" | "wire-bounds",
    immutableBytes: string,
  ) => Promise<boolean>;
  reserveAtomic?: (input: MonetaryAtomicInput) => Promise<unknown>;
};
/** No defaults, key loading, new identity, provider endpoint, second ledger,
 * AppModule activation or fallback to the v1 token-only store. */
export class BenchMonetaryV2Receiver {
  constructor(private readonly deps: MonetaryV2Dependencies) {}
  async reserveEnvelope(raw: unknown) {
    try {
      const value = monetaryEnvelopeSchema.parse(raw);
      requireBench(
        this.deps.verifyProof && this.deps.reserveAtomic,
        "monetary_executor_not_bound",
      );
      const grant = monetaryGrantSchema.parse(
        JSON.parse(
          verifyEnvelope(
            value.signed_grant,
            this.deps.issuerPublicKey,
            "BENCH-GRANT-v2\n",
          ),
        ),
      );
      // Reuse existing caller/counter checks without accepting a v1 signature.
      const callerGrant = {
        ...grant,
        schema: "NativeBenchAdmission/v1" as const,
      };
      const started = this.deps.now();
      const deadline = Math.min(
        grant.expires_unix,
        value.operation_deadline_unix,
        started + 5,
        callerDeadline(
          value.caller_access_token,
          this.deps.authArcanaJwks,
          callerGrant,
          started,
          "bench:reserve",
        ),
      );
      requireBench(
        value.operation_deadline_unix > started &&
          value.operation_deadline_unix <= started + 5,
        "operation_deadline_invalid",
      );
      let proofDeadline = Infinity;
      const assertFresh = () => {
        const now = this.deps.now();
        requireBench(
          now >= started && now < Math.min(deadline, proofDeadline),
          "authenticated_operation_expired",
        );
        checkGrant(callerGrant, now);
        verifyCaller(
          value.caller_access_token,
          this.deps.authArcanaJwks,
          callerGrant,
          now,
          "bench:reserve",
        );
      };
      assertFresh();
      const pub = createPublicKey(this.deps.custodianPrivateKey);
      requireBench(
        pub.asymmetricKeyType === "ed25519" &&
          !pub
            .export({ format: "der", type: "spki" })
            .equals(
              this.deps.issuerPublicKey.export({ format: "der", type: "spki" }),
            ) &&
          Buffer.from(
            pub.export({ format: "jwk" }).x ?? "",
            "base64url",
          ).toString("hex") === grant.custodian_public_key,
        "custodian_key_not_separate_or_bound",
      );
      requireBench(
        grant.custodian_socket === this.deps.socketPath,
        "socket_not_grant_bound",
      );
      const req = value.request,
        money = req.monetary_request;
      const scope = [
        "campaign",
        "account",
        "provider",
        "model",
        "source_sha256",
        "binary_sha256",
        "journal_id",
      ] as const;
      for (const key of scope)
        requireBench(
          req[key] === grant[key] && money[key] === grant[key],
          "money_scope_mismatch",
        );
      requireBench(
        req.subject === grant.subject &&
          req.attempt === grant.attempt &&
          money.attempt === req.attempt &&
          money.nonce === req.nonce &&
          money.original_ledger_sha256 === grant.original_ledger_sha256 &&
          req.bounds_proof_sha256 === grant.bounds_proof_sha256 &&
          req.monetary_checkpoint_head_sha256 ===
            grant.monetary.expected_head_sha256,
        "money_request_not_grant_bound",
      );
      requireBench(
        req.caps.every((n, i) => n === CAPS[i]) &&
          req.retained_baseline.every(
            (n, i) => n === grant.retained_baseline[i],
          ),
        "counter_binding",
      );
      const bytes = Buffer.from(value.wire_utf8, "utf8");
      requireBench(
        bytes.toString("utf8") === value.wire_utf8 &&
          bytes.length === req.wire_utf8_bytes &&
          bytes.length === req.input_token_upper_bound &&
          req.reserved[0] === 1 &&
          req.reserved[1] === bytes.length &&
          req.reserved[2] === grant.hard_output_tokens &&
          digest(bytes) === req.wire_sha256 &&
          money.wire_sha256 === req.wire_sha256,
        "actual_wire_not_bound",
      );
      requireBench(
        Buffer.byteLength(value.charging_policy_utf8) <= 65536 &&
          Buffer.byteLength(value.wire_bounds_utf8) <= 65536 &&
          digest(value.charging_policy_utf8) === money.policy_sha256 &&
          money.policy_sha256 === grant.monetary.policy_sha256 &&
          digest(value.wire_bounds_utf8) === money.bounds_sha256 &&
          money.bounds_sha256 === grant.monetary.bounds_sha256,
        "proof_digest_mismatch",
      );
      for (const [kind, rawProof] of [
        ["charging-policy", value.charging_policy_utf8],
        ["wire-bounds", value.wire_bounds_utf8],
      ] as const) {
        requireBench(
          (await this.deps.verifyProof!(kind, rawProof)) === true,
          "unverified_money_proof",
        );
        assertFresh();
      }
      const policy = policySchema.parse(JSON.parse(value.charging_policy_utf8));
      const bounds = boundsSchema.parse(JSON.parse(value.wire_bounds_utf8));
      proofDeadline = Math.min(policy.expires, bounds.expires);
      for (const [proof, rawProof] of [
        [policy, value.charging_policy_utf8],
        [bounds, value.wire_bounds_utf8],
      ] as const) {
        requireBench(
          monetaryCanonical(proof) === rawProof,
          "noncanonical_money_proof",
        );
        for (const key of [...scope, "original_ledger_sha256"] as const)
          requireBench(proof[key] === money[key], "proof_scope_mismatch");
        requireBench(
          proof.not_before <= started && proof.expires > this.deps.now(),
          "money_proof_expired",
        );
      }
      requireBench(
        bounds.wire_sha256 === req.wire_sha256 &&
          bounds.input_upper === bytes.length &&
          bounds.output_upper === req.reserved[2] &&
          BigInt(bounds.input_upper) + BigInt(bounds.output_upper) <=
            BigInt(bounds.context_limit),
        "qualified_bound_mismatch",
      );
      requireBench(
        policy.money_floor <= policy.money_cap &&
          policy.money_cap <= policy.scale &&
          policy.retained_counters.every(
            (n, i) => n >= grant.retained_baseline[i] && n <= CAPS[i],
          ),
        "original_money_or_counter_cap",
      );
      wireSchema.parse(JSON.parse(value.wire_utf8));
      assertFresh();
      const snapshot = JSON.parse(
        canonical({ request: req, policy, bounds, wire: value.wire_utf8,
          charging_policy_utf8: value.charging_policy_utf8,
          wire_bounds_utf8: value.wire_bounds_utf8,
          deadline_unix: Math.min(deadline, proofDeadline) }),
      );
      const receipt = receiptSchema.parse(
        await this.deps.reserveAtomic!({ ...snapshot, assertFresh }),
      );
      // Late success never signs: incumbent UNKNOWN remains spent, no retry/refund.
      assertFresh();
      requireBench(
        policy.expires > this.deps.now() && bounds.expires > this.deps.now(),
        "money_proof_expired",
      );
      const m = receipt.monetary;
      const integerCost =
        BigInt(policy.fixed_fee) +
        [policy.input_rate, policy.output_rate].reduce(
          (sum, [num, den], i) =>
            sum +
            (BigInt(req.reserved[i + 1]) * BigInt(num) + BigInt(den) - 1n) /
              BigInt(den),
          0n,
        );
      requireBench(
        policy.mode === "subscription_no_incremental_charge"
          ? integerCost === 0n
          : integerCost > 0n,
        "charging_mode_invalid",
      );
      const expectedProjection = digest(
        monetaryCanonical({
          request: money,
          previous: {
            head: req.monetary_checkpoint_head_sha256,
            counters: m.counters_before,
            money: m.previous_money,
            currency: policy.currency,
            scale: policy.scale,
            policy_sha256: money.policy_sha256,
          },
          reserved: req.reserved,
          cost: m.cost,
        }),
      );
      requireBench(
        canonical(receipt.request) === canonical(req) &&
          canonical(m.request) === canonical(money) &&
          receipt.valid_until_unix > this.deps.now() &&
          receipt.valid_until_unix <= Math.min(deadline, proofDeadline) &&
          m.scale === policy.scale &&
          m.cap === policy.money_cap &&
          m.floor === policy.money_floor &&
          m.previous_head_sha256 === req.monetary_checkpoint_head_sha256 &&
          receipt.previous_head_sha256 === m.previous_head_sha256 &&
          receipt.head_sha256 === m.head_sha256 &&
          m.projection_binding_sha256 === expectedProjection &&
          m.head_sha256 !== m.previous_head_sha256 &&
          m.previous_money >= m.floor &&
          BigInt(m.cost) === integerCost &&
          BigInt(m.previous_money) + integerCost === BigInt(m.next_money) &&
          m.next_money <= m.cap &&
          m.counters_before.every((n, i) => n >= policy.retained_counters[i]) &&
          receipt.aggregate.every(
            (n, i) =>
              BigInt(n) ===
                BigInt(m.counters_before[i]) + BigInt(req.reserved[i]) &&
              n <= CAPS[i],
          ) &&
          receipt.sequence === receipt.aggregate[0],
        "atomic_money_receipt_mismatch",
      );
      return signed(
        receipt,
        this.deps.custodianPrivateKey,
        "BENCH-CUSTODY-RESERVATION-v2\n",
      );
    } catch {
      // Incumbent callbacks may throw typed errors containing their input.
      // Never propagate callback/token/proof/body exceptions to a caller.
      throw new BenchRefused("monetary_v2_refused_unknown_preserved");
    }
  }
}
