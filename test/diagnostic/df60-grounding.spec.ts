import { describe, expect, it } from 'vitest';
import { classifyLocalGrounding } from './df60-grounding';
const request = {
  prompt: JSON.stringify({
    fixture_only: true,
    source: { fixture_only: true, id: 'local-r1', assertions: [{ key: 'colour', value: 'blue' }] },
    requested_key: 'colour',
  }),
};
describe('actual local-source classifier controls', () => {
  it('accepts a supported claim and refuses wrong source/key/value', () => {
    const answer = {
      status: 'answered',
      reason: null,
      claims: [{ source_id: 'local-r1', key: 'colour', value: 'blue' }],
    };
    expect(classifyLocalGrounding(request, answer)).toBe('supported_answer');
    for (const [field, value] of [
      ['source_id', 'foreign-r2'],
      ['key', 'price'],
      ['value', 'red'],
    ]) {
      const changed = structuredClone(answer);
      changed.claims[0][field as 'source_id' | 'key' | 'value'] = value;
      expect(classifyLocalGrounding(request, changed)).toBe('unsupported_claim');
    }
  });
  it('accepts refusal only when input has no supporting assertion', () => {
    const refusal = { status: 'refused', claims: [], reason: 'NO_SUPPORTING_REVISION' };
    expect(classifyLocalGrounding(request, refusal)).toBe('unsupported_refusal');
    const missing = {
      prompt: request.prompt.replace('"requested_key":"colour"', '"requested_key":"price"'),
    };
    expect(classifyLocalGrounding(missing, refusal)).toBe('supported_refusal');
    expect(classifyLocalGrounding(missing, { ...refusal, reason: 'GENERIC_ERROR' })).toBe(
      'unsupported_refusal',
    );
  });
  it('refuses conflicting source values rather than selecting a convenient assertion', () => {
    const input = JSON.parse(request.prompt);
    input.source.assertions.push({ key: 'colour', value: 'red' });
    const conflict = { prompt: JSON.stringify(input) };
    expect(
      classifyLocalGrounding(conflict, {
        status: 'answered',
        reason: null,
        claims: [{ source_id: 'local-r1', key: 'colour', value: 'blue' }],
      }),
    ).toBe('source_conflict');
    expect(
      classifyLocalGrounding(conflict, {
        status: 'refused',
        claims: [],
        reason: 'NO_SUPPORTING_REVISION',
      }),
    ).toBe('source_conflict');
    input.source.assertions = [{ key: 'colour', value: 42 }];
    expect(classifyLocalGrounding({ prompt: JSON.stringify(input) }, {})).toBe('invalid_source');
  });
  it('does not infer a structured observation or local authority', () => {
    expect(classifyLocalGrounding(request, undefined)).toBe('no_structured_observation');
    expect(() => classifyLocalGrounding({ prompt: '{}' }, {})).toThrow(
      'local source identity absent',
    );
  });
});
