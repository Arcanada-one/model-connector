/**
 * BILL-0008 (consilium §6.3) — the credit endpoint's input bounds.
 *
 * Tested through the controller rather than by exporting the Zod schema,
 * because the property that matters is "the ENDPOINT refuses this", not "a
 * private constant is shaped a certain way". A schema tested in isolation stays
 * green if someone stops calling it.
 *
 * Billing is a stub here on purpose: the assertion is that it is NEVER REACHED.
 * A validation test that lets the call through and then checks a return value
 * cannot tell "rejected" from "accepted and happened to be harmless".
 */

import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CreditsController } from './credits.controller';
import { BillingService, MAX_CREDIT_USD } from './billing.service';
import { BillingReconcilerService } from './reconciler.service';

const KEY = 'aaaaaaaa-0000-4000-8000-000000000000';

describe('CreditsController input bounds', () => {
  let controller: CreditsController;
  let credit: ReturnType<typeof vi.fn>;
  let gift: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    credit = vi.fn().mockResolvedValue(true);
    gift = vi.fn().mockResolvedValue(true);
    const billing = {
      credit,
      gift,
      balance: vi.fn().mockResolvedValue({ toString: () => '0' }),
    } as unknown as BillingService;
    controller = new CreditsController(billing, {} as BillingReconcilerService);
  });

  const validKey = { idempotencyKey: 'topup-000001' };

  it('accepts an ordinary credit', async () => {
    await controller.credit(KEY, { amountUsd: '25.50', ...validKey });
    expect(credit).toHaveBeenCalledOnce();
  });

  /**
   * THE REGRESSION. `CreditSchema` refined only `Number(v) > 0`, and
   * `Number("Infinity") > 0` is true. `GiftSchema` had carried the
   * `Number.isFinite` refine all along, so the two schemas guarding the same
   * money differed in exactly the way that mattered and the weaker one was the
   * top-up path. `new Prisma.Decimal(Infinity)` then survives `credit()`'s own
   * `greaterThan(0)`, so nothing downstream catches it either.
   */
  it.each(['Infinity', '-Infinity', 'NaN', Infinity])(
    'rejects a non-finite amount (%s) without reaching the ledger',
    async (amountUsd) => {
      await expect(controller.credit(KEY, { amountUsd, ...validKey })).rejects.toThrow(
        BadRequestException,
      );
      expect(credit).not.toHaveBeenCalled();
    },
  );

  it('rejects an amount above the per-credit ceiling', async () => {
    // "Finite" is not a bound, and there is no un-post.
    await expect(
      controller.credit(KEY, { amountUsd: MAX_CREDIT_USD + 1, ...validKey }),
    ).rejects.toThrow(BadRequestException);
    expect(credit).not.toHaveBeenCalled();
  });

  it('accepts an amount exactly at the ceiling', async () => {
    // The bound is inclusive; an off-by-one here would refuse a legitimate
    // credit at the documented maximum.
    await controller.credit(KEY, { amountUsd: MAX_CREDIT_USD, ...validKey });
    expect(credit).toHaveBeenCalledOnce();
  });

  it.each([0, -1, '0'])('rejects a non-positive amount (%s)', async (amountUsd) => {
    await expect(controller.credit(KEY, { amountUsd, ...validKey })).rejects.toThrow(
      BadRequestException,
    );
    expect(credit).not.toHaveBeenCalled();
  });

  it('applies the same ceiling to a gift', async () => {
    // A gift creates balance by identical arithmetic and is equally un-postable.
    await expect(
      controller.gift(KEY, {
        amountUsd: MAX_CREDIT_USD + 1,
        idempotencyKey: 'gift-000001',
        reason: 'too much',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(gift).not.toHaveBeenCalled();
  });

  it('still rejects a non-finite gift', async () => {
    await expect(
      controller.gift(KEY, {
        amountUsd: 'Infinity',
        idempotencyKey: 'gift-000002',
        reason: 'unbounded',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(gift).not.toHaveBeenCalled();
  });
});
