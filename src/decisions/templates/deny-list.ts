/**
 * Global evaluative-name deny-list for DecisionRequest state (JEV-DECISION-LAYER-SPEC §7.4).
 * Case-insensitive; substring match on compound keys (e.g. security_review_status).
 * ARCA-JEV-02 contract binding — swap for @arcanada/jev-decision-templates when published.
 */
export const STATE_FIELD_DENY_LIST: readonly string[] = [
  'approved',
  'approval',
  'approved_by',
  'reviewer_note',
  'review',
  'reviewed',
  'risk',
  'risk_assessment',
  'risk_level',
  'security_review',
  'verdict',
  'decision',
  'safe',
  'safety',
  'severity',
  'priority',
  'recommendation',
  'assessment',
  'evaluation',
  'rating',
  'score',
  'confidence',
  'status',
  'label',
  'verified',
  'validated',
  'passed',
  'ok',
  'note',
  'comment',
] as const;

export function denyListHit(fieldName: string): string | null {
  const lower = fieldName.toLowerCase();
  for (const token of STATE_FIELD_DENY_LIST) {
    if (lower === token || lower.includes(token)) return token;
  }
  return null;
}
