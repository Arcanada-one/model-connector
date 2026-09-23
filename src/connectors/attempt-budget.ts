/**
 * A2-210 — how long ONE attempt is allowed to take, decided in one place for
 * both transports.
 *
 * Three figures claim a say and, until now, the third was decoration:
 *
 *   `request.timeout`              what the caller asked for (DTO: 5 000…600 000 ms)
 *   `getTimeout()`                 what this connector is configured to allow (A2-207)
 *   `getCapabilities().maxTimeout` what this connector ADVERTISES it can do
 *
 * A2-206 found `maxTimeout` read by nobody: seventeen connectors declared it,
 * the catalog published it, and no code path consulted it. A2-207 (#139) fixed
 * the second figure and left the third alone. So a connector could advertise a
 * 60 000 ms ceiling (`embedding`) and be handed the DTO's full 600 000 by any
 * caller who asked — an advertised limit that limited nothing, and a caller who
 * believed the catalog waiting ten times longer than the catalog promised.
 *
 * It is wired here as a CEILING rather than deleted, because deleting it would
 * throw away the only per-connector statement of what the provider can actually
 * sustain — and the catalog already shows it to callers as if it were binding.
 *
 * The ceiling binds both lower figures: an operator who sets
 * `CONNECTOR_TIMEOUT_MS=300000` on a connector advertising 60 000 is asking for
 * something that connector says it cannot do. Clamping is silent by design —
 * there is no failure to report, the request simply gets the largest deadline
 * the connector stands behind.
 */
export interface AttemptBudget {
  /** The per-attempt deadline to hand the transport. */
  timeoutMs: number;
  /**
   * True when the CALLER asked for strictly less time than this connector would
   * have allowed. A2-207 (#139): such a timeout is not evidence about the
   * provider and must not feed the shared per-model breaker. Compared AFTER
   * clamping, so a caller who asks for more than the ceiling and is cut down to
   * it does not thereby become "impatient".
   */
  callerBudgetIsShorter: boolean;
}

export function resolveAttemptBudget(
  requestTimeoutMs: number | undefined,
  connectorBudgetMs: number,
  advertisedMaxTimeoutMs: number | undefined,
): AttemptBudget {
  // A connector that advertises nothing usable (absent, 0, NaN from a
  // hand-built capabilities object) imposes no ceiling: an unreadable
  // advertisement must not silently become a zero-millisecond deadline.
  const ceiling =
    typeof advertisedMaxTimeoutMs === 'number' &&
    Number.isFinite(advertisedMaxTimeoutMs) &&
    advertisedMaxTimeoutMs > 0
      ? advertisedMaxTimeoutMs
      : undefined;

  const clamp = (ms: number): number => (ceiling !== undefined ? Math.min(ms, ceiling) : ms);

  const connectorBudget = clamp(connectorBudgetMs);
  const callerBudget = requestTimeoutMs !== undefined ? clamp(requestTimeoutMs) : undefined;

  return {
    timeoutMs: callerBudget ?? connectorBudget,
    callerBudgetIsShorter: callerBudget !== undefined && callerBudget < connectorBudget,
  };
}
