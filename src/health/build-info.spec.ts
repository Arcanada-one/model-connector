import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInfo } from './build-info';

/**
 * A2-228 — each case shows the field going wrong in a distinct way before the one green case is
 * trusted. The point of `build` on /health is that a client can tell "this build" from "some other
 * build"; a field that quietly reported a plausible value when it did not know one would defeat
 * that more thoroughly than having no field at all.
 */
describe('buildInfo', () => {
  it('reports the commit the image was built from', () => {
    const sha = '9e73861772ffbc88bca3eea51debe11692e2339b';
    expect(buildInfo({ MC_BUILD_SHA: sha })).toEqual({ sha, source: 'MC_BUILD_SHA' });
  });

  it('accepts a short id and normalises case, so a deploy that shortens the sha still names it', () => {
    expect(buildInfo({ MC_BUILD_SHA: '9E73861' })).toEqual({
      sha: '9e73861',
      source: 'MC_BUILD_SHA',
    });
  });

  it.each([
    ['unset', {}],
    ['empty', { MC_BUILD_SHA: '' }],
    ['whitespace', { MC_BUILD_SHA: '   ' }],
  ])('reports no build when MC_BUILD_SHA is %s — never a guess', (_label, env) => {
    const info = buildInfo(env);
    expect(info.sha).toBeNull();
    expect(info.source).toBeNull();
    expect(info.problem).toContain('not_measured');
  });

  it.each([
    ['a branch name', 'main'],
    ['a version string', 'v1.2.3'],
    ['too short to be an id', 'abc'],
    ['not hex', 'zzzzzzz'],
  ])('refuses %s rather than serving it as a commit', (_label, value) => {
    const info = buildInfo({ MC_BUILD_SHA: value });
    expect(info.sha).toBeNull();
    expect(info.problem).toContain('not a commit id');
  });

  /**
   * The wiring, not the function: a build arg that reaches the image but is never read, or a
   * compose file that never passes it, would leave `build.sha` null on every deploy while every
   * unit test above stayed green.
   */
  it('is wired from the deploy through compose into the image', () => {
    const root = join(__dirname, '..', '..');
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const deploy = readFileSync(join(root, 'deploy', 'deploy.sh'), 'utf8');

    expect(dockerfile).toMatch(/^ARG MC_BUILD_SHA=/m);
    expect(dockerfile).toMatch(/^ENV MC_BUILD_SHA=\$MC_BUILD_SHA$/m);
    expect(compose).toMatch(/MC_BUILD_SHA: \$\{MC_BUILD_SHA:-\}/);
    expect(deploy).toMatch(/MC_BUILD_SHA="\$\(git rev-parse HEAD/);
    expect(deploy).toMatch(/^export MC_BUILD_SHA$/m);
  });
});
