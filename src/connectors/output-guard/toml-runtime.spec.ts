import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { repair } from '@arcanada/output-guard';

/**
 * A2-435 — `output_format: 'toml'` is parsed by `smol-toml`, which reaches us only through
 * `@arcanada/output-guard`; no other test calls the real parser. A bump of `smol-toml`
 * (A2-432: 1.6.1 → 1.9.0, a rewritten parser) was therefore invisible to the suite.
 *
 * `smol-toml` is not our direct dependency, so it is resolved from output-guard's own location:
 * that is the exact copy the running guard loads, whatever pnpm links at the top level.
 */
const guardRequire = createRequire(require.resolve('@arcanada/output-guard'));
const smolToml = guardRequire('smol-toml') as {
  parse: (text: string) => unknown;
  TomlError: new (...args: unknown[]) => Error;
};

const VALID = [
  'title = "probe"',
  'count = 3',
  '',
  '[owner]',
  'name = "mc"',
  'tags = ["a", "b"]',
].join('\n');

describe('smol-toml (real parser, as loaded by output-guard)', () => {
  it('parses a valid document into the values it spells', () => {
    expect(smolToml.parse(VALID)).toEqual({
      title: 'probe',
      count: 3,
      owner: { name: 'mc', tags: ['a', 'b'] },
    });
  });

  it('throws TomlError on a malformed document', () => {
    expect(() => smolToml.parse('key = = 1')).toThrow(smolToml.TomlError);
  });

  it('gives output-guard the parsed data for a document no repair strategy touches', () => {
    expect(repair('[owner]\nname = "mc"', 'toml').data).toEqual({ owner: { name: 'mc' } });
  });

  it('lets output-guard refuse a document no strategy can make into TOML', () => {
    expect(() => repair('[[[ = = =', 'toml')).toThrow();
  });
});

/**
 * A2-435 found, and these cases pin, a defect in @arcanada/output-guard 0.1.0 that does not depend
 * on the smol-toml version (1.6.1 and 1.9.0 measured alike): `repair()` runs its JSON-oriented
 * strategies over TOML and parses the rewritten text even when the original was valid TOML.
 * `extract-json` cuts a document down to its first `[table]` header, silently dropping every key
 * before it; `fix-inner-quotes` breaks a multi-line document with a string value so that it is
 * refused. `it.fails` keeps them in the suite: when output-guard is fixed they turn red and must
 * become plain `it`.
 */
describe('output-guard repair on valid TOML (known defect, output-guard 0.1.0)', () => {
  it.fails('keeps the keys that come before the first table', () => {
    expect(repair(VALID, 'toml').data).toEqual({
      title: 'probe',
      count: 3,
      owner: { name: 'mc', tags: ['a', 'b'] },
    });
  });

  it.fails('accepts a multi-line document with a string value', () => {
    expect(repair('title = "probe"\ncount = 3', 'toml').data).toEqual({ title: 'probe', count: 3 });
  });
});
