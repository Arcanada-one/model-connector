#!/usr/bin/env node
/**
 * A2-319 — reproducible proof that the per-key rate limit (A2-301) can refuse.
 *
 * "Zero 429s in production" says the live agents are not throttled; it does
 * not say a 429 can happen at all. This probe makes one happen, on purpose,
 * on keys it creates and revokes itself:
 *
 *   1. mints a disposable key LIMITED to `--limit` requests per 60s window
 *      (default 2) and a disposable key WITHIN its limit (the default 60);
 *   2. sends `limit + 2` requests with the limited key to an API-key route
 *      that costs nothing upstream (default `GET /connectors`) and requires
 *      the first `limit` to be 200 and the rest 429 with `Retry-After` >= 1;
 *   3. sends 3 requests with the within-limit key and requires 200 for each;
 *   4. revokes both keys — always, also when a step fails.
 *
 * PASS (exit 0) only if a 429 with Retry-After was observed AND the other key
 * stayed at 200. Against a build without `RateLimitGuard` (main before #152)
 * the probe gets no 429 and exits 1 — that is its red control, recorded in the
 * PR. Exit 2 = could not run (no token, admin API refused, key not minted).
 *
 * `--via patch` mints the limited key at the default limit and lowers it with
 * `PATCH /admin/keys/:id/rate-limit`, so the same run also proves the A2-319
 * admin route changes what the HTTP surface allows. `--via create` (default)
 * sets the limit at creation and works on builds that predate that route.
 *
 * Usage (on the MC host, over loopback — /admin is denied at the public vhost):
 *   ADMIN_TOKEN=... node scripts/rate-limit-probe.mjs \
 *     [--base http://127.0.0.1:3900] [--limit 2] [--via create|patch] \
 *     [--path /connectors] [--actor <who-runs-this>]
 * In the production container the token is already in the environment:
 *   docker exec model-connector-model-connector-1 node scripts/rate-limit-probe.mjs --via patch
 *
 * Never prints a key value or the admin token: only key ids, names, statuses.
 */

export const WINDOW_SECONDS = 60;
/** Do not start a burst this close to the fixed-window seam (epoch-aligned). */
export const SEAM_GUARD_SECONDS = 5;

export function parseArgs(argv) {
  const opts = {
    base: 'http://127.0.0.1:3900',
    limit: 2,
    via: 'create',
    path: '/connectors',
    actor: 'rate-limit-probe',
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!flag.startsWith('--') || value === undefined) throw new Error(`bad argument: ${flag}`);
    const name = flag.slice(2);
    if (!(name in opts)) throw new Error(`unknown option: ${flag}`);
    opts[name] = name === 'limit' ? Number.parseInt(value, 10) : value;
    i++;
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 20) {
    throw new Error('--limit must be an integer 1..20');
  }
  if (opts.via !== 'create' && opts.via !== 'patch') throw new Error('--via must be create|patch');
  return opts;
}

/**
 * Pure verdict over what the probe observed. Kept separate so the decision
 * rule itself is tested, not re-implemented in the test.
 */
export function judge({ limit, limited, within }) {
  const reasons = [];
  const expectedAllowed = limited.slice(0, limit);
  const expectedRefused = limited.slice(limit);
  if (!expectedAllowed.every((r) => r.status === 200)) {
    reasons.push(`limited key: first ${limit} requests not all 200`);
  }
  const refused = expectedRefused.filter((r) => r.status === 429);
  if (refused.length === 0) reasons.push('limited key: no 429 observed past the limit');
  else if (refused.length !== expectedRefused.length) {
    reasons.push('limited key: not every request past the limit was 429');
  }
  if (refused.some((r) => !(Number(r.retryAfter) >= 1))) {
    reasons.push('limited key: a 429 without Retry-After >= 1');
  }
  if (!within.every((r) => r.status === 200)) reasons.push('within-limit key: not all 200');
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

export async function runProbe({
  opts,
  adminToken,
  fetchImpl = fetch,
  log = console.log,
  now = Date.now,
  sleep,
}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const admin = (method, path, body) =>
    fetchImpl(`${opts.base}${path}`, {
      method,
      headers: {
        'x-admin-token': adminToken,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const stamp = new Date(now()).toISOString().replace(/[-:.]/g, '');
  const minted = [];
  try {
    const mint = async (suffix, rateLimit) => {
      const res = await admin('POST', '/admin/keys', {
        name: `rl-probe-${stamp}-${suffix}`,
        ...(rateLimit ? { rateLimit } : {}),
      });
      if (res.status !== 201)
        throw Object.assign(new Error(`mint ${suffix}: HTTP ${res.status}`), { setup: true });
      const body = await res.json();
      minted.push(body.id);
      log(`minted ${suffix} keyId=${body.id} name=${body.name}`);
      return body;
    };

    const limitedKey = await mint('limited', opts.via === 'create' ? opts.limit : undefined);
    const withinKey = await mint('within');

    if (opts.via === 'patch') {
      const res = await admin('PATCH', `/admin/keys/${limitedKey.id}/rate-limit`, {
        rateLimit: opts.limit,
        actor: opts.actor,
        reason: 'A2-319 rate-limit probe',
      });
      if (res.status !== 200) {
        throw Object.assign(new Error(`PATCH rate-limit: HTTP ${res.status}`), { setup: true });
      }
      const body = await res.json();
      log(
        `patched keyId=${limitedKey.id} rateLimit ${body.previousRateLimit} -> ${body.rateLimit}`,
      );
    }

    // The window is epoch-aligned (floor(now/60s)); a burst straddling the
    // seam would be split across two counters and could miss the 429.
    const into = Math.floor(now() / 1000) % WINDOW_SECONDS;
    if (into > WINDOW_SECONDS - SEAM_GUARD_SECONDS) {
      const ms = (WINDOW_SECONDS - into + 1) * 1000;
      log(`waiting ${ms}ms past the window seam`);
      await wait(ms);
    }

    const hit = async (key) => {
      const res = await fetchImpl(`${opts.base}${opts.path}`, {
        headers: { authorization: `Bearer ${key.key}` },
      });
      await res.text();
      return { status: res.status, retryAfter: res.headers.get('retry-after') };
    };

    const limited = [];
    for (let i = 0; i < opts.limit + 2; i++) limited.push(await hit(limitedKey));
    const within = [];
    for (let i = 0; i < 3; i++) within.push(await hit(withinKey));

    log(
      `limited (limit ${opts.limit}): ${limited.map((r) => r.status + (r.retryAfter ? `[Retry-After ${r.retryAfter}]` : '')).join(' ')}`,
    );
    log(`within  (limit 60): ${within.map((r) => r.status).join(' ')}`);
    const result = judge({ limit: opts.limit, limited, within });
    return { ...result, limited, within };
  } catch (err) {
    return {
      verdict: err.setup ? 'SETUP_ERROR' : 'FAIL',
      reasons: [err.message],
      limited: [],
      within: [],
    };
  } finally {
    for (const id of minted) {
      const res = await admin('DELETE', `/admin/keys/${id}`).catch((e) => ({ status: e.message }));
      log(`revoked keyId=${id}: HTTP ${res.status}`);
    }
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error('ADMIN_TOKEN is not set (the admin API is guarded by the x-admin-token header)');
    process.exit(2);
  }
  const result = await runProbe({ opts, adminToken });
  console.log(
    `VERDICT ${result.verdict}${result.reasons.length ? ` — ${result.reasons.join('; ')}` : ''}`,
  );
  process.exit(result.verdict === 'PASS' ? 0 : result.verdict === 'FAIL' ? 1 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
