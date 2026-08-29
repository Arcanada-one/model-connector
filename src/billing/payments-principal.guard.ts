import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';

import { secretsMatch } from '../common/secret-compare';

/** Where the resolved caller identity is parked for the controller to read. */
export const PAYMENTS_PRINCIPAL = 'paymentsPrincipal';

/**
 * BILL-0008 / SEC-0075 — who is allowed to post a payment credit.
 *
 * The credit-in path must NOT be the `ADMIN_TOKEN` surface. Consilium §6.1
 * found `POST /admin/credits/:id/gift` world-reachable behind one static
 * shared token with `@Public()` on the controller, no rate limit, no
 * attribution and rotation-by-redeploy, and called it a publicly-addressable
 * money mint more urgent than BILL-0008 itself. Hanging the payment path off
 * the same token would widen that surface at the exact moment it starts
 * handling money a stranger actually sent.
 *
 * So this is a separate guard, a separate header pair, a separate environment
 * variable, and — the part that matters — a NAMED caller. `ADMIN_TOKEN` cannot
 * answer "who did this"; every credit mutation has to be attributable before
 * live intake (consilium §4.6), and the name this guard resolves is written
 * into `credits_ledger.actor` on the row it authorises.
 *
 * ══ THIS IS AN AUTH SEAM ══════════════════════════════════════════════════
 *
 * The correct long-term authentication is mesh identity — a client certificate
 * or a mesh-issued token that control-bff cannot forge and an outsider cannot
 * obtain — and standing that up is operator-gated (it needs the mesh CA and a
 * deploy-side decision that is not this stream's to make). It is recorded in
 * waits-for-operator.
 *
 * What ships instead is a per-principal shared secret with the SAME shape as
 * the real thing: a caller presents an identity and proves it, and the
 * identity reaches the ledger row. Replacing it means rewriting exactly one
 * method — {@link PaymentsPrincipalGuard.resolvePrincipal} — and nothing
 * downstream of it, because nothing downstream knows how the name was proved.
 *
 * The seam is honest about what it is NOT: a shared secret in an environment
 * variable is stronger than `ADMIN_TOKEN` only in being scoped and named. It
 * is not mesh identity, and this endpoint must not be exposed publicly on the
 * strength of it — the nginx `/internal` denial is a separate, required
 * control (SEC-0075).
 * ══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class PaymentsPrincipalGuard implements CanActivate {
  private readonly logger = new Logger(PaymentsPrincipalGuard.name);

  /**
   * A principal secret below this many characters is refused outright, even if
   * it matches. The failure this prevents is an operator setting
   * `PAYMENTS_PRINCIPALS=control-bff:test` to get a deploy working and it
   * surviving into live intake, where the endpoint mints balance.
   */
  static readonly MIN_SECRET_LENGTH = 32;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const principal = this.resolvePrincipal(request);
    if (!principal) return false;

    // The controller reads this to write `credits_ledger.actor`. An
    // authenticated caller whose name never reaches the row would satisfy the
    // guard and defeat the point of having one.
    request[PAYMENTS_PRINCIPAL] = principal;
    return true;
  }

  /**
   * THE SEAM. Return the caller's name, or null to deny.
   *
   * Swapping the shared secret for mesh identity replaces this method's body
   * and nothing else: it returns a name either way, and every caller of it
   * only ever cares that a name came back.
   */
  private resolvePrincipal(request: {
    headers: Record<string, string | string[] | undefined>;
  }): string | null {
    const name = single(request.headers['x-payments-principal']);
    const token = single(request.headers['x-payments-token']);
    if (!name || !token) return this.deny('missing-principal-or-token');

    const configured = PaymentsPrincipalGuard.principals();
    if (configured.size === 0) {
      // Fail closed. An unconfigured payments surface must deny everyone, not
      // wave everyone through — the whole endpoint mints balance.
      return this.deny('no-principals-configured');
    }

    const expected = configured.get(name);
    if (!expected) {
      // Deliberately the same reason code path as a bad token below would take
      // if we cared to distinguish them; we do not, because "is this a real
      // principal name?" is not a question an unauthenticated caller should be
      // able to ask for free.
      return this.deny('unknown-principal');
    }
    if (expected.length < PaymentsPrincipalGuard.MIN_SECRET_LENGTH) {
      return this.deny('principal-secret-too-short');
    }

    // SEC-0075, structurally enforced rather than merely documented: if the
    // operator has configured a principal whose secret IS the admin token,
    // this endpoint has silently become the ADMIN_TOKEN surface again. Refuse
    // and say so — a config mistake that re-creates the exact exposure the
    // separate guard exists to avoid must fail loudly, not authenticate.
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken && secretsMatch(expected, adminToken)) {
      this.logger.error(
        `payments auth refused: principal '${name}' is configured with the ADMIN_TOKEN value. ` +
          'The payment credit path must not be the admin surface (SEC-0075). ' +
          'Give it its own secret.',
      );
      return null;
    }

    // `secretsMatch` hashes both sides to a fixed width before comparing, so
    // there is no length pre-check and nothing that can throw — see
    // src/common/secret-compare.ts and consilium §6.2.
    if (!secretsMatch(token, expected)) {
      return this.deny('token-mismatch');
    }
    return name;
  }

  /**
   * `PAYMENTS_PRINCIPALS=name:secret,other:secret`.
   *
   * Read per-request rather than cached at construction so a rotation takes
   * effect on restart of the process only — which is the same guarantee the
   * other token guards give — without the guard holding a stale copy for the
   * lifetime of a long-running instance.
   */
  private static principals(): Map<string, string> {
    const raw = process.env.PAYMENTS_PRINCIPALS;
    const out = new Map<string, string>();
    if (!raw) return out;

    for (const pair of raw.split(',')) {
      const idx = pair.indexOf(':');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      // Not trimmed: a secret's trailing space is part of the secret, and
      // silently trimming it turns a working credential into a mystery 403.
      const secret = pair.slice(idx + 1);
      if (name && secret) out.set(name, secret);
    }
    return out;
  }

  /** One log call site for every denial. Reason codes only, never values. */
  private deny(reason: string): null {
    this.logger.warn(`payments auth denied: reason=${reason}`);
    return null;
  }
}

/**
 * Fastify delivers a duplicated header as an array. Picking the first element
 * would let a caller send two `x-payments-principal` headers and have the
 * guard and any downstream reader disagree about which one was authenticated.
 */
function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return undefined;
  return value;
}
