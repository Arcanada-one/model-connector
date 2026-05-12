// CONN-0089 — output-guard middleware contract types
// MC-domain mapping of @arcanada/output-guard library outcomes.

/**
 * `pass` semantics in MC's `repair_report`:
 *  - `native`   — first attempt parsed + schema-validated cleanly with NO repair
 *                 strategies applied. Only meaningful when connector supports
 *                 provider-native structured output (supportsJsonSchema=true).
 *  - `guarded`  — library validate-and-repair succeeded (pass A or B). Either
 *                 strategies were applied OR ≥1 retry was needed.
 *  - `failed`   — `MAX_RETRIES` exhausted; response surface returned with
 *                 `error.type = 'guard_exhausted'`.
 */
export type OutputGuardPass = 'native' | 'guarded' | 'failed';

export interface OutputGuardReport {
  strategies_applied: string[];
  retries: number;
  final_valid: boolean;
  pass: OutputGuardPass;
  error?: string;
}

export interface OutputGuardMetrics {
  retries: number;
  finalValid: boolean;
  pass: OutputGuardPass;
  strategiesApplied: string[];
}
