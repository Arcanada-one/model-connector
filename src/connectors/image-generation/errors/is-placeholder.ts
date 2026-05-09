/**
 * Returns true when the given credential value is a PLACEHOLDER sentinel
 * (written by Vault prep scripts with `PLACEHOLDER_<TASK-ID>` convention)
 * or is empty/blank — i.e. the provider is not yet provisioned.
 *
 * See: memory feedback_vault_placeholder_password, CONN-0052 Phase 0.
 */
export function isPlaceholder(value: string): boolean {
  if (!value || !value.trim()) return true;
  return value.startsWith('PLACEHOLDER_');
}
