import type { RawCase } from './df60-adapter';

/** Observed structured output checked against the actual local input source. */
export function classifyLocalGrounding(request: RawCase['request'], structured: unknown) {
  const source = JSON.parse(request.prompt) as {
    fixture_only?: boolean;
    source?: { fixture_only?: boolean; id?: string; assertions?: { key: string; value: string }[] };
    requested_key?: string;
  };
  if (source.fixture_only !== true || source.source?.fixture_only !== true)
    throw new Error('DIAG local source identity absent');
  const assertions = source.source.assertions;
  if (
    typeof source.source.id !== 'string' ||
    typeof source.requested_key !== 'string' ||
    !Array.isArray(assertions) ||
    assertions.some(
      (item) => !item || typeof item.key !== 'string' || typeof item.value !== 'string',
    )
  )
    return 'invalid_source';
  const matching = assertions.filter((item) => item.key === source.requested_key);
  if (new Set(matching.map((item) => item.value)).size > 1) return 'source_conflict';
  if (!structured || typeof structured !== 'object') return 'no_structured_observation';
  const result = structured as { status?: unknown; claims?: unknown; reason?: unknown };
  if (!Array.isArray(result.claims)) return 'invalid_claims';
  if (result.status === 'refused')
    return result.claims.length === 0 &&
      matching.length === 0 &&
      result.reason === 'NO_SUPPORTING_REVISION'
      ? 'supported_refusal'
      : 'unsupported_refusal';
  if (result.status !== 'answered' || result.reason !== null || result.claims.length === 0)
    return 'invalid_answer';
  const supported = result.claims.every((claim: unknown) => {
    if (!claim || typeof claim !== 'object') return false;
    const row = claim as { source_id?: unknown; key?: unknown; value?: unknown };
    return (
      row.source_id === source.source!.id &&
      row.key === source.requested_key &&
      matching.some((item) => item.key === row.key && item.value === row.value)
    );
  });
  return supported ? 'supported_answer' : 'unsupported_claim';
}
