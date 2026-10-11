import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeRawCase, main } from './df60-raw-cli';
const raw = {
  id: 'local',
  request: { prompt: 'fixture' },
  stdout: '{}',
  stderr: '',
  exitCode: 0,
  fault: 'none',
};
function bound(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return [bytes, createHash('sha256').update(bytes).digest('hex')] as const;
}
describe('raw CLI source boundaries (no PG/namespace execution)', () => {
  it('accepts a bound raw-only input', () => {
    expect(decodeRawCase(...bound(raw)).id).toBe('local');
  });
  it('refuses oracle fields even when their bytes are bound', () => {
    expect(() => decodeRawCase(...bound({ ...raw, expected: 'answered' }))).toThrow(
      'shape refused',
    );
  });
  it('refuses changed bytes', () => {
    const [bytes] = bound(raw);
    expect(() => decodeRawCase(bytes, '0'.repeat(64))).toThrow('binding refused');
  });
  it('refuses malformed JSON without parser excerpt', () => {
    const bytes = Buffer.from('{"private": broken');
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(() => decodeRawCase(bytes, digest)).toThrow('DIAG raw input decoding refused');
  });
  it('refuses missing CLI arguments before any resource construction', async () => {
    await expect(main([])).rejects.toThrow('arity refused');
  });
});
