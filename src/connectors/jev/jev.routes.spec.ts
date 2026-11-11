import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudflareSuccessFixture,
  measuredCloudflareApiError,
  measuredCloudflareModelId,
  measuredDirectAuthError,
  measuredDirectNativeResponse,
  measuredDirectRequestQuestions,
  measuredOpenRouterAuthError,
  measuredOpenRouterModelId,
  measuredState,
  openRouterSuccessFixture,
} from './jev.route-fixtures';
import {
  CloudflareRoute,
  DirectRoute,
  JEV_ROUTES,
  JevRoute,
  JevRouteEnv,
  OpenRouterRoute,
  jevRouteCatalogEntries,
} from './jev.routes';

const direct = new DirectRoute();
const openrouter = new OpenRouterRoute();
const cloudflare = new CloudflareRoute();

const routes: Array<{
  route: JevRoute;
  modelId: string;
  successBody: unknown;
  authErrorBody: unknown;
  keyedEnv: JevRouteEnv;
  emptyEnv: JevRouteEnv;
}> = [
  {
    route: direct,
    modelId: 'jev-latest',
    successBody: measuredDirectNativeResponse,
    authErrorBody: measuredDirectAuthError,
    keyedEnv: {
      TYPESAFE_API_KEY: 'synthetic-direct',
      TYPESAFE_JEV_ROUTES_ENABLED: 'direct,openrouter,cloudflare',
    },
    emptyEnv: { TYPESAFE_JEV_ROUTES_ENABLED: 'direct,openrouter,cloudflare' },
  },
  {
    route: openrouter,
    modelId: measuredOpenRouterModelId,
    successBody: openRouterSuccessFixture,
    authErrorBody: measuredOpenRouterAuthError,
    keyedEnv: {
      TYPESAFE_JEV_OPENROUTER_API_KEY: 'synthetic-or',
      TYPESAFE_JEV_ROUTES_ENABLED: 'direct,openrouter,cloudflare',
    },
    emptyEnv: { TYPESAFE_JEV_ROUTES_ENABLED: 'direct,openrouter,cloudflare' },
  },
  {
    route: cloudflare,
    modelId: measuredCloudflareModelId,
    successBody: cloudflareSuccessFixture,
    authErrorBody: measuredCloudflareApiError,
    keyedEnv: {
      TYPESAFE_JEV_CLOUDFLARE_API_TOKEN: 'synthetic-cf',
      TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID: 'acct-fixture',
      TYPESAFE_JEV_ROUTES_ENABLED: 'direct,openrouter,cloudflare',
    },
    emptyEnv: {
      TYPESAFE_JEV_ROUTES_ENABLED: 'direct,openrouter,cloudflare',
      TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID: 'acct-fixture',
    },
  },
];

describe('CONN-JEV-02 JevRoute contract (parameterized)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(routes)(
    '$route.id builds measured request body shape and never puts model inside Cloudflare input',
    ({ route, modelId }) => {
      const body = route.buildBody(measuredState, measuredDirectRequestQuestions, modelId);
      if (route.id === 'cloudflare') {
        expect(body).toEqual({
          model: measuredCloudflareModelId,
          input: { state: measuredState, questions: measuredDirectRequestQuestions },
        });
        expect(body).toEqual(
          expect.objectContaining({
            input: expect.not.objectContaining({ model: expect.anything() }),
          }),
        );
        // Explicit negative: model must not appear inside input (§2.4 schema).
        expect((body as { input: Record<string, unknown> }).input).not.toHaveProperty('model');
      } else {
        expect(body).toEqual({
          state: measuredState,
          model: modelId,
          questions: measuredDirectRequestQuestions,
        });
      }
    },
  );

  it.each(routes)('$route.id buildUrl matches measured path shape', ({ route, keyedEnv }) => {
    const url = route.buildUrl(keyedEnv);
    if (route.id === 'direct') {
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    } else if (route.id === 'openrouter') {
      expect(url).toBe('https://openrouter.ai/api/v1/systemone');
    } else {
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-fixture/ai/run');
    }
  });

  it.each(routes)(
    '$route.id parse extracts model_observed / usage without inventing zeros',
    ({ route, successBody }) => {
      const parsed = route.parse(successBody);
      expect(parsed.answers).toBeTruthy();
      expect(Object.keys(parsed.answers).length).toBeGreaterThan(0);
      expect(parsed.usage).toEqual({ input_tokens: 474, output_tokens: 76 });
      expect(parsed.usage_missing).toBeUndefined();
      if (route.id === 'cloudflare') {
        // Version in Cloudflare envelope: unmeasured → not_observable by default.
        expect(parsed.model_observed).toBe('not_observable');
        expect(route.versionObservability()).toBe('not_observable');
      } else if (route.id === 'openrouter') {
        expect(parsed.model_observed).toBe('typesafe/jev-1.13-20260917');
        expect(route.versionObservability()).toBe('dated_slug');
      } else {
        expect(parsed.model_observed).toBe('jev-1.13.0');
        expect(route.versionObservability()).toBe('observed');
      }
    },
  );

  it.each(routes)(
    '$route.id parseHttpError maps auth envelopes without inventing retry-after',
    ({ route, authErrorBody }) => {
      const status = route.id === 'cloudflare' ? 200 : 401;
      // Cloudflare often returns HTTP 200 with success:false; transport errors use JSON errors[].
      const err = route.parseHttpError(
        status === 200 ? 401 : status,
        JSON.stringify(authErrorBody),
      );
      expect(err.type).toBe('auth_error');
      expect(err.retryable).toBe(false);
      expect(err.retryAfterMs).toBeNull();
      expect(err.message.length).toBeGreaterThan(0);
    },
  );

  it.each(routes)(
    '$route.id empty key → route_not_configured without network headers',
    ({ route, emptyEnv }) => {
      expect(route.assertConfigured(emptyEnv)).toEqual({
        ok: false,
        error: 'route_not_configured',
      });
      const headers = route.headers(emptyEnv);
      expect(headers).toEqual({ ok: false, error: 'route_not_configured' });
    },
  );

  it.each(routes)('$route.id keyed env yields Authorization headers', ({ route, keyedEnv }) => {
    const headers = route.headers(keyedEnv);
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: expect.stringMatching(/^Bearer /),
      'User-Agent': expect.stringMatching(/^arcanada-model-connector\//),
    });
  });

  it('stub/unavailable catalog rows report available:false (negative control)', () => {
    const empty: JevRouteEnv = {};
    const rows = jevRouteCatalogEntries(empty);
    const openrouterRows = rows.filter((r) => r.route === 'openrouter');
    const cloudflareRows = rows.filter((r) => r.route === 'cloudflare');
    expect(openrouterRows.length).toBeGreaterThan(0);
    expect(cloudflareRows.length).toBeGreaterThan(0);
    expect(openrouterRows.every((r) => r.available === false)).toBe(true);
    expect(cloudflareRows.every((r) => r.available === false)).toBe(true);
    // Direct also false without key — never invent live success.
    expect(rows.filter((r) => r.route === 'direct').every((r) => r.available === false)).toBe(true);
  });

  it('direct becomes available only when keyed; stubs stay false without their keys', () => {
    const env: JevRouteEnv = {
      TYPESAFE_API_KEY: 'direct-only',
      TYPESAFE_JEV_ROUTES_ENABLED: 'direct,openrouter,cloudflare',
    };
    const rows = jevRouteCatalogEntries(env);
    expect(rows.filter((r) => r.route === 'direct').every((r) => r.available)).toBe(true);
    expect(rows.filter((r) => r.route === 'openrouter').every((r) => !r.available)).toBe(true);
    expect(rows.filter((r) => r.route === 'cloudflare').every((r) => !r.available)).toBe(true);

    // Instance getters read process.env — stub the same shape.
    vi.stubEnv('TYPESAFE_API_KEY', 'direct-only');
    vi.stubEnv('TYPESAFE_JEV_ROUTES_ENABLED', 'direct,openrouter,cloudflare');
    vi.stubEnv('TYPESAFE_JEV_OPENROUTER_API_KEY', '');
    vi.stubEnv('TYPESAFE_JEV_CLOUDFLARE_API_TOKEN', '');
    expect(direct.available).toBe(true);
    expect(openrouter.available).toBe(false);
    expect(cloudflare.available).toBe(false);
  });

  it('Cloudflare path-embedded addressing fork is explicit and still forbids model in input', () => {
    const cf = new CloudflareRoute();
    cf.addressing = 'path_embedded';
    const env: JevRouteEnv = {
      TYPESAFE_JEV_CLOUDFLARE_API_TOKEN: 't',
      TYPESAFE_JEV_CLOUDFLARE_ACCOUNT_ID: 'acct',
      TYPESAFE_JEV_ROUTES_ENABLED: 'cloudflare',
    };
    expect(cf.buildUrl(env)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/typesafe/jev',
    );
    const body = cf.buildBody(measuredState, measuredDirectRequestQuestions, 'typesafe/jev');
    expect(body).toEqual({
      input: { state: measuredState, questions: measuredDirectRequestQuestions },
    });
    expect((body as { input: object }).input).not.toHaveProperty('model');
  });

  it('429 without retry-after header keeps retryAfterMs null (unmeasured)', () => {
    const err = direct.parseHttpError(429, '{"detail":{"message":"slow down"}}');
    expect(err.type).toBe('rate_limited');
    expect(err.retryAfterMs).toBeNull();
    const withHeader = direct.parseHttpError(
      429,
      '{"detail":{"message":"slow down"}}',
      new Headers({ 'retry-after': '3' }),
    );
    expect(withHeader.retryAfterMs).toBe(3000);
  });

  it('JEV_ROUTES exports all three implementations behind one interface', () => {
    expect(JEV_ROUTES.map((r) => r.id)).toEqual(['direct', 'openrouter', 'cloudflare']);
    for (const r of JEV_ROUTES) {
      expect(typeof r.buildUrl).toBe('function');
      expect(typeof r.buildBody).toBe('function');
      expect(typeof r.headers).toBe('function');
      expect(typeof r.parse).toBe('function');
      expect(typeof r.parseHttpError).toBe('function');
      expect(typeof r.modelIds).toBe('function');
      expect(typeof r.pricingSource).toBe('function');
      expect(typeof r.versionObservability).toBe('function');
      expect(typeof r.assertConfigured).toBe('function');
      expect(typeof r.available).toBe('boolean');
    }
  });
});
