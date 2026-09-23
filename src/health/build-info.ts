/**
 * What commit this process was built from — or the reason it cannot say.
 *
 * WHY THIS EXISTS (A2-228). Nothing in the Model Connector's HTTP surface named its build. Measured
 * on 2026-09-23, `GET /health` answered `{"status":"ok","timestamp":…}` on production AND on a
 * second instance running on arcana-devs from a worktree whose `dist/` was compiled on 2026-09-13,
 * a month behind main and without the DeepSeek price map. A2-221 measured 36 calls through that
 * instance and recorded `costUsd: 0` on all of them. The receipt said which ADDRESS it had called.
 * There was no way, over HTTP, to learn which BUILD had answered — so a month-old binary and the
 * deployed one were indistinguishable to every client that measured them.
 *
 * `/health` now carries `build`. A harness records it; a deploy can compare it; a bug report can
 * name it.
 *
 * WHERE THE VALUE COMES FROM. `MC_BUILD_SHA`, baked into the image at build time from the commit
 * the deploy checked out (`Dockerfile` ARG → ENV, fed by `deploy/deploy.sh`). Deliberately NOT read
 * from a `.git` directory at runtime: the production image contains none, and a value that only
 * appears in development would be worse than no value at all — it would make `build.sha: null` look
 * like an environment quirk rather than what it is.
 *
 * THE THIRD VERDICT. When `MC_BUILD_SHA` is absent or not a commit id, `sha` is `null` and
 * `problem` says why. A client must read that as `not_measured` — never as a pass, and never as
 * proof that the build is old. A hand-started development instance is expected to land here.
 */

/** A 7-to-64 character hex string: a short or full git object id, and nothing else. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

export interface BuildInfo {
  sha: string | null;
  source: 'MC_BUILD_SHA' | null;
  problem?: string;
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const raw = (env.MC_BUILD_SHA ?? '').trim();
  if (!raw) {
    return {
      sha: null,
      source: null,
      problem:
        'MC_BUILD_SHA is not set, so this process cannot name the commit it was built from. ' +
        'It is baked into the image by deploy/deploy.sh; an instance started by hand from a ' +
        'worktree has no value to report. Read this as not_measured, never as a pass.',
    };
  }
  if (!COMMIT_ID.test(raw)) {
    return {
      sha: null,
      source: null,
      problem: `MC_BUILD_SHA is not a commit id (${raw.length} chars), so it is reported as no build rather than as one`,
    };
  }
  return { sha: raw.toLowerCase(), source: 'MC_BUILD_SHA' };
}
