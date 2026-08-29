import { describe, expect, it } from 'vitest';

import { secretsMatch } from './secret-compare';

/**
 * ARAS-0058 (consilium §6.2). The property under test is not "does it compare
 * correctly" — the old code did that too, for every input that did not crash
 * it. It is "can a caller make it throw", because a throw is a 500 where every
 * other wrong token is a 403, and that difference reads back the byte length
 * of the secret one probe at a time.
 */
describe('secretsMatch', () => {
  const SECRET = 'a'.repeat(32);

  it('accepts the exact secret', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
  });

  it('rejects a different secret of the same length', () => {
    expect(secretsMatch('b'.repeat(32), SECRET)).toBe(false);
  });

  it('rejects a shorter and a longer candidate without throwing', () => {
    expect(secretsMatch('short', SECRET)).toBe(false);
    expect(secretsMatch('a'.repeat(4096), SECRET)).toBe(false);
  });

  it('rejects the empty string on either side', () => {
    // An unset environment variable read as '' must never authenticate a
    // caller who also sends ''.
    expect(secretsMatch('', SECRET)).toBe(false);
    expect(secretsMatch(SECRET, '')).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
  });

  /**
   * THE REGRESSION. This is the input the pre-fix code could not survive:
   * 'é' is one UTF-16 code unit and two UTF-8 bytes, so a 32-character token
   * containing it passes a `token.length !== expected.length` pre-check and
   * then reaches `timingSafeEqual` with a 33-byte buffer against a 32-byte one,
   * which throws `RangeError: Input buffers must have the same byte length`.
   */
  it('does not throw on a multi-byte character at equal STRING length', () => {
    const oracle = 'é' + 'a'.repeat(31);
    expect(oracle.length).toBe(SECRET.length);
    expect(Buffer.byteLength(oracle, 'utf8')).not.toBe(Buffer.byteLength(SECRET, 'utf8'));

    expect(() => secretsMatch(oracle, SECRET)).not.toThrow();
    expect(secretsMatch(oracle, SECRET)).toBe(false);
  });

  it('does not throw on any multi-byte probe across a range of lengths', () => {
    // The single case above proves the specific defect is gone; sweeping the
    // length space proves the fix is not a special case for one input. A guard
    // that survives 'é' at 32 and crashes on '💥' at 40 is not fixed.
    for (let n = 1; n <= 64; n++) {
      const probe = '💥'.repeat(n);
      expect(() => secretsMatch(probe, SECRET)).not.toThrow();
      expect(secretsMatch(probe, SECRET)).toBe(false);
    }
  });
});
