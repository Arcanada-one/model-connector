import { describe, it, expect, vi } from 'vitest';
import { judge, parseArgs, runProbe } from './rate-limit-probe.mjs';

// A2-319: the probe's decision rule and its always-revoke contract. What the
// probe SEES from a real server is proven by running it against real builds
// (head -> PASS, a build without RateLimitGuard -> FAIL); receipts in the PR.

const ok = { status: 200, retryAfter: null };
const refused = { status: 429, retryAfter: '37' };

describe('judge', () => {
  it('PASS: limit x 200, then 429 with Retry-After; the other key stays 200', () => {
    expect(judge({ limit: 2, limited: [ok, ok, refused, refused], within: [ok, ok, ok] })).toEqual({
      verdict: 'PASS',
      reasons: [],
    });
  });

  it('FAIL when no 429 is seen — the red control against a guardless build', () => {
    const r = judge({ limit: 2, limited: [ok, ok, ok, ok], within: [ok, ok, ok] });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toContain('limited key: no 429 observed past the limit');
  });

  it('FAIL on a 429 without Retry-After, an early 429, or a throttled within-limit key', () => {
    expect(
      judge({
        limit: 2,
        limited: [ok, ok, { status: 429, retryAfter: null }, refused],
        within: [ok],
      }).verdict,
    ).toBe('FAIL');
    expect(
      judge({ limit: 2, limited: [ok, refused, refused, refused], within: [ok] }).verdict,
    ).toBe('FAIL');
    expect(
      judge({ limit: 2, limited: [ok, ok, refused, refused], within: [ok, refused] }).verdict,
    ).toBe('FAIL');
  });
});

describe('parseArgs', () => {
  it('defaults, and refuses unknown or out-of-range options', () => {
    expect(parseArgs([])).toMatchObject({ limit: 2, via: 'create', path: '/connectors' });
    expect(parseArgs(['--via', 'patch', '--limit', '3'])).toMatchObject({ via: 'patch', limit: 3 });
    expect(() => parseArgs(['--limit', '0'])).toThrow();
    expect(() => parseArgs(['--via', 'sql'])).toThrow();
    expect(() => parseArgs(['--nope', 'x'])).toThrow();
  });
});

describe('runProbe', () => {
  const res = (status, body = {}, headers = {}) => ({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k) => headers[k] ?? null },
  });

  it('revokes every key it minted even when the burst step throws, and never logs a key value', async () => {
    let n = 0;
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url.replace('http://mc', '')}`);
      if (init.method === 'POST') {
        n++;
        return res(201, { id: `id-${n}`, name: `k${n}`, key: `mc-secret-${n}` });
      }
      if (init.method === 'DELETE') return res(204);
      throw new Error('connection reset');
    });
    const lines = [];
    const r = await runProbe({
      opts: parseArgs(['--base', 'http://mc']),
      adminToken: 'admin-secret',
      fetchImpl,
      log: (l) => lines.push(l),
      now: () => Date.UTC(2026, 8, 25, 10, 0, 10),
    });
    expect(r.verdict).toBe('FAIL');
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([
      'DELETE /admin/keys/id-1',
      'DELETE /admin/keys/id-2',
    ]);
    expect(lines.join('\n')).not.toMatch(/mc-secret|admin-secret/);
  });

  it('SETUP_ERROR (exit 2) when the admin API refuses to mint', async () => {
    const r = await runProbe({
      opts: parseArgs([]),
      adminToken: 'wrong',
      fetchImpl: async () => res(403),
      log: () => undefined,
    });
    expect(r.verdict).toBe('SETUP_ERROR');
  });
});
