/**
 * BILL-0008 — the inbound credit contract the payments module calls.
 *
 * This is the MC half of the split in consilium §1: the payments module lives
 * in control-bff, which owns `payment_intent`, the Oxapay adapter, the webhook
 * and every policy question about under-, over- and late-payment. Model
 * Connector owns the ledger and exposes exactly one way in.
 *
 * The route is `/internal/...`, NOT `/admin/...`, and that is not cosmetic.
 * Consilium §6.1 found the existing `/admin/credits/:id/gift` world-reachable
 * behind one static `ADMIN_TOKEN` — a publicly-addressable money mint (SEC-0075).
 * A payment path hung off the same prefix would inherit both the token and,
 * more importantly, the nginx vhost's failure to fence it. A separate prefix is
 * what makes `location /internal { deny all; }` expressible at all.
 *
 * WHAT CROSSES THE BOUNDARY, and why the list is this short (consilium §2):
 * `apiKeyId`, `amountUsd`, `idempotencyKey`, `source` — four scalars. No coin
 * ticker, no network, no wallet address, no tx hash, no confirmation count, no
 * exchange rate, no crypto pay-amount, no provider status string. The signature
 * IS the enforcement: a leak cannot pass through a shape with nowhere to put
 * it, which is a guarantee no amount of documentation gives.
 *
 * `externalRef` and `livemode` ride along because neither is a crypto concept —
 * every gateway has an immutable reference and a test/live distinction, Stripe
 * and PayPal included — and neither can be backfilled onto a row already
 * posted.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../auth/public.decorator';
import { BillingService, MAX_CREDIT_USD } from './billing.service';
import { ReversalRefusedError } from './billing.errors';
import { PAYMENTS_PRINCIPAL, PaymentsPrincipalGuard } from './payments-principal.guard';

/**
 * A money amount arriving over HTTP.
 *
 * Accepts a string as well as a number on purpose: JSON numbers are IEEE
 * doubles and a caller sending `180.10` has already lost precision the ledger's
 * DECIMAL(12,6) would have kept.
 *
 * Both refines are load-bearing and neither implies the other. `Number.isFinite`
 * is the one consilium §6.3 found missing from `CreditSchema`, where
 * `amountUsd: "Infinity"` passed `Number(v) > 0` and reached a Decimal that
 * compares greater than everything. The ceiling is the one that matters after
 * that: "finite" is not a bound, and there is no un-post.
 */
const MoneyAmount = z
  .union([z.number(), z.string()])
  .refine((v) => Number.isFinite(Number(v)), 'amountUsd must be a finite number')
  .refine((v) => Number(v) > 0, 'amountUsd must be greater than zero')
  .refine(
    (v) => Number(v) <= MAX_CREDIT_USD,
    `amountUsd must not exceed ${MAX_CREDIT_USD} — a larger single credit is a typo or an attack, and there is no un-post`,
  );

const PaymentSchema = z.object({
  amountUsd: MoneyAmount,
  /**
   * Namespaced by the caller on the gateway's own immutable reference —
   * `oxapay:payment:<track_id>`, never our client-supplied `order_id`, which a
   * customer can pre-burn (consilium §5). Riding the existing
   * `credits_ledger.idempotencyKey @unique` rather than adding a second
   * mechanism is consilium §9.3.
   */
  idempotencyKey: z.string().min(8).max(200),
  /** The provider that took the money. The only provider-shaped string here. */
  source: z.string().trim().min(2).max(50),
  /**
   * Required, with no default. Consilium §5's sandbox trap: if a gateway's
   * sandbox is a per-invoice flag on the same merchant credential, live and
   * test callbacks are signed by the same key and this column is the only
   * boundary that exists. A default would pick a side on the caller's behalf,
   * and either choice is wrong — defaulting true mislabels sandbox money as
   * real, defaulting false mislabels real money as a test.
   */
  livemode: z.boolean(),
  externalRef: z.string().min(1).max(200).optional(),
  reason: z.string().trim().max(200).optional(),
  /**
   * AUDIT ONLY, and inert by construction — see `PaymentValuation`. Nothing
   * here is read to compute the credit; `amountUsd` arrives already decided by
   * control-bff, which is what keeps consilium §2's prohibition true even
   * though §4.2 requires the rate at receipt to be recorded.
   */
  valuation: z
    .object({
      assetAmount: z.union([z.number(), z.string()]).optional(),
      asset: z.string().trim().min(1).max(20).optional(),
      usdRateAtReceipt: z.union([z.number(), z.string()]).optional(),
      valuedAt: z.coerce.date().optional(),
    })
    .optional(),
});

const ReverseSchema = z.object({
  /** The `idempotency_key` of the entry being reversed. */
  originalIdempotencyKey: z.string().min(8).max(200),
  /** Positive magnitude; the ledger row is written negative. */
  amountUsd: MoneyAmount,
  /** The reversal's OWN key — reversing is idempotent too. */
  idempotencyKey: z.string().min(8).max(200),
  /**
   * Required and non-trivial, on the same grounds as a gift's: taking money
   * back is a movement an auditor must be able to explain from the ledger
   * alone.
   */
  reason: z.string().trim().min(3).max(200),
  /** Voluntary, or taken back by the provider. Defaults to the voluntary one. */
  entryType: z.enum(['refund', 'chargeback']).default('refund'),
});

@Controller('internal/credits')
// `@Public()` bypasses the API-key auth guard — an inference key must never be
// able to credit itself. The route is not public: `PaymentsPrincipalGuard`
// replaces that authentication with a named, attributable principal.
@Public()
@UseGuards(PaymentsPrincipalGuard)
export class PaymentsController {
  constructor(private readonly billing: BillingService) {}

  /**
   * Credit money a customer actually sent.
   *
   * Idempotent by the ledger's unique index: `applied: false` means the key was
   * already used and NOTHING happened. A replayed webhook — which consilium §3
   * calls the normal case, not the edge case — is a no-op, and the response
   * says so explicitly so a retrying caller can never read it as a second
   * credit.
   */
  @Post(':apiKeyId/payment')
  @HttpCode(HttpStatus.OK)
  async payment(
    @Param('apiKeyId') apiKeyId: string,
    @Body() body: unknown,
    @Req() request: Record<string, unknown>,
  ) {
    const parsed = PaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    const actor = PaymentsController.actorOf(request);

    const applied = await this.billing.recordPayment({
      apiKeyId,
      amountUsd: parsed.data.amountUsd,
      idempotencyKey: parsed.data.idempotencyKey,
      source: parsed.data.source,
      livemode: parsed.data.livemode,
      externalRef: parsed.data.externalRef,
      reason: parsed.data.reason,
      actor,
      valuation: parsed.data.valuation,
    });
    const balance = await this.billing.balance(apiKeyId);

    return {
      apiKeyId,
      applied,
      entryType: 'payment',
      balanceUsd: balance.toString(),
    };
  }

  /**
   * Post a negative entry reversing an earlier credit.
   *
   * Reachable rather than merely present because consilium §4.1 makes the
   * absence of any reversal path the hard gate: without it the only way to undo
   * a bad irreversible credit is to hand-write a row outside every ledger
   * invariant. Behind the same attributable principal as the credit path —
   * taking money back is at least as sensitive as putting it in.
   *
   * `recoveredUsd` and `writtenOffUsd` are returned separately because they are
   * different outcomes: the first is money taken back off the balance, the
   * second is money the customer had already spent and we could not recover.
   */
  @Post(':apiKeyId/reverse')
  @HttpCode(HttpStatus.OK)
  async reverse(
    @Param('apiKeyId') apiKeyId: string,
    @Body() body: unknown,
    @Req() request: Record<string, unknown>,
  ) {
    const parsed = ReverseSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues);
    }
    const actor = PaymentsController.actorOf(request);

    try {
      const result = await this.billing.reverse({
        originalIdempotencyKey: parsed.data.originalIdempotencyKey,
        amountUsd: parsed.data.amountUsd,
        idempotencyKey: parsed.data.idempotencyKey,
        reason: parsed.data.reason,
        entryType: parsed.data.entryType,
        actor,
      });
      const balance = await this.billing.balance(apiKeyId);
      return { apiKeyId, ...result, balanceUsd: balance.toString() };
    } catch (err) {
      // A refused reversal is a well-formed request with a correct negative
      // answer — "no such payment", "already fully reversed", "that is a
      // charge" — not a fault. 400 with the stable code, so the payments module
      // can branch without parsing a message and its retry logic does not treat
      // a permanent refusal as transient.
      if (err instanceof ReversalRefusedError) {
        throw new BadRequestException({ code: err.code, reason: err.reason, message: err.message });
      }
      throw err;
    }
  }

  /**
   * The authenticated caller's name, as the guard resolved it.
   *
   * Throws rather than defaulting to 'unknown'. Reaching a handler with no
   * principal means the guard did not run — a routing or module wiring mistake
   * — and the correct response to "I cannot tell who is crediting this account"
   * is to refuse, not to post an unattributable money row and carry on.
   */
  private static actorOf(request: Record<string, unknown>): string {
    const actor = request[PAYMENTS_PRINCIPAL];
    if (typeof actor !== 'string' || !actor) {
      throw new ForbiddenException('no authenticated payments principal on this request');
    }
    return actor;
  }
}
