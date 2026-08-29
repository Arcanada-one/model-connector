import { ExecutionContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PAYMENTS_PRINCIPAL, PaymentsPrincipalGuard } from './payments-principal.guard';

const SECRET = 'p'.repeat(40);
const OTHER_SECRET = 'q'.repeat(40);

/** Returns the request object too, so the test can assert what was attached. */
function contextFor(headers: Record<string, string | string[]>) {
  const request: Record<string, unknown> = { headers };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

function creds(name = 'control-bff', token = SECRET) {
  return { 'x-payments-principal': name, 'x-payments-token': token };
}

describe('PaymentsPrincipalGuard', () => {
  let guard: PaymentsPrincipalGuard;

  beforeEach(() => {
    guard = new PaymentsPrincipalGuard();
    process.env.PAYMENTS_PRINCIPALS = `control-bff:${SECRET}`;
  });

  afterEach(() => {
    delete process.env.PAYMENTS_PRINCIPALS;
    delete process.env.ADMIN_TOKEN;
  });

  it('admits a configured principal presenting its secret', () => {
    const { ctx } = contextFor(creds());
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('attaches the principal NAME to the request', () => {
    // The name is the whole point: consilium §4.6 requires every credit
    // mutation to be attributable, and a guard that authenticates without
    // naming the caller leaves `credits_ledger.actor` empty on money rows.
    const { ctx, request } = contextFor(creds());
    guard.canActivate(ctx);
    expect(request[PAYMENTS_PRINCIPAL]).toBe('control-bff');
  });

  it('fails closed when no principals are configured', () => {
    // An unconfigured surface that minted balance would be the worst possible
    // default, and it is the default a `!expected` check reversed by accident
    // would produce.
    delete process.env.PAYMENTS_PRINCIPALS;
    const { ctx } = contextFor(creds());
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it.each([
    ['no headers at all', {}],
    ['a name with no token', { 'x-payments-principal': 'control-bff' }],
    ['a token with no name', { 'x-payments-token': SECRET }],
    ['an unknown principal', creds('attacker', SECRET)],
    ['the right name and the wrong secret', creds('control-bff', OTHER_SECRET)],
  ])('denies %s', (_label, headers) => {
    const { ctx } = contextFor(headers);
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('denies a duplicated header rather than picking one', () => {
    const { ctx } = contextFor({
      'x-payments-principal': ['control-bff', 'attacker'],
      'x-payments-token': SECRET,
    });
    expect(guard.canActivate(ctx)).toBe(false);
  });

  /**
   * SEC-0075. The point of a separate guard is that the payment path is NOT the
   * `ADMIN_TOKEN` surface. Configuring a principal with the admin token's value
   * silently makes it that surface again, so it is refused rather than
   * authenticated — a config mistake that re-creates the exposure the guard
   * exists to prevent must fail loudly.
   */
  it('refuses a principal configured with the ADMIN_TOKEN value', () => {
    const adminToken = 'A'.repeat(40);
    process.env.ADMIN_TOKEN = adminToken;
    process.env.PAYMENTS_PRINCIPALS = `control-bff:${adminToken}`;

    const { ctx } = contextFor(creds('control-bff', adminToken));
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('never admits an ADMIN_TOKEN presented as a payments token', () => {
    process.env.ADMIN_TOKEN = 'A'.repeat(40);
    const { ctx } = contextFor(creds('control-bff', 'A'.repeat(40)));
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('refuses a principal whose configured secret is too short to be one', () => {
    // The failure this prevents: an operator sets a placeholder to get a deploy
    // working and it survives into live intake on an endpoint that mints
    // balance.
    process.env.PAYMENTS_PRINCIPALS = 'control-bff:test';
    const { ctx } = contextFor(creds('control-bff', 'test'));
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('does not crash on a multi-byte token of equal string length (crash-oracle)', () => {
    // The consilium warned that any new guard written like AdminGuard inherits
    // its RangeError oracle. This one routes through `secretsMatch`; the test
    // is here so a future edit cannot quietly reintroduce a length pre-check.
    const oracle = 'é' + 'p'.repeat(39);
    expect(oracle.length).toBe(SECRET.length);

    const { ctx } = contextFor(creds('control-bff', oracle));
    expect(() => guard.canActivate(ctx)).not.toThrow();
    expect(guard.canActivate(ctx)).toBe(false);
  });

  it('reads several configured principals and keeps them distinct', () => {
    process.env.PAYMENTS_PRINCIPALS = `control-bff:${SECRET},reconciler:${OTHER_SECRET}`;

    expect(guard.canActivate(contextFor(creds('control-bff', SECRET)).ctx)).toBe(true);
    expect(guard.canActivate(contextFor(creds('reconciler', OTHER_SECRET)).ctx)).toBe(true);
    // Each principal proves ITS OWN secret; one valid credential must not
    // authenticate a different name.
    expect(guard.canActivate(contextFor(creds('reconciler', SECRET)).ctx)).toBe(false);
  });
});
