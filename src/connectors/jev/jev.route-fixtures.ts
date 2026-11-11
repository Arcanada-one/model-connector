/**
 * Measured envelope fixtures for CONN-JEV-02 (TZ §2.2 / §2.4, 2026-09-22).
 * Synthetic reconstruction of documented live observations — not a live probe.
 * Unmeasured Cloudflare success fields stay explicit (`not_observable` / null).
 */

/** Direct live sample shape: three primitives, usage 474/76 (§2.2). */
export const measuredDirectRequestQuestions = {
  domain: {
    type: 'choice' as const,
    instructions: 'Classify the change domain',
    criteria: {
      infra: 'Infrastructure',
      app: 'Application',
      other: 'Other',
    },
  },
  complexity: {
    type: 'score' as const,
    instructions: 'Rate complexity',
    criteria: ['Low', 'Medium', 'High'],
  },
  safe: {
    type: 'noul' as const,
    instructions: 'Is the change safe?',
  },
};

/** Measured answers from the three-primitive live call (§2.2). */
export const measuredDirectNativeResponse = {
  model: 'jev-1.13.0',
  answers: {
    domain: {
      choice: 'infra',
      confidence: 0.99,
      // Confidence formula uses provider-normalized distance above uniform;
      // fixture keeps the documented winner + confidence pair.
      probabilities: { infra: 0.993333, app: 0.003333, other: 0.003334 },
    },
    complexity: {
      score: 1.2,
      // Σ(index × p) = 0×0.05 + 1×0.70 + 2×0.25 = 1.20 (§2.2).
      probabilities: [0.05, 0.7, 0.25],
    },
    safe: { noul: 0.82 },
  },
  usage: { input_tokens: 474, output_tokens: 76 },
};

/** Measured direct error envelope (§2.4). */
export const measuredDirectAuthError = {
  detail: { error_type: 'authentication_error', message: 'Invalid API key' },
};

/** OpenRouter request uses the same System-One body; model id is route-specific. */
export const measuredOpenRouterModelId = 'typesafe/jev-1.13';

/**
 * OpenRouter success response was NOT live-measured without a key.
 * Fixture uses the dated-slug shape documented in §2.4; CONN-JEV-09 may replace
 * bytes after a live smoke — not the JevRoute interface.
 */
export const openRouterSuccessFixture = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    domain: {
      choice: 'infra',
      confidence: 0.99,
      probabilities: { infra: 0.993333, app: 0.003333, other: 0.003334 },
    },
    complexity: { score: 1.2, probabilities: [0.05, 0.7, 0.25] },
    safe: { noul: 0.82 },
  },
  usage: { input_tokens: 474, output_tokens: 76 },
};

/** Measured OpenRouter error envelope (§2.4): `{"error":{…}}`. */
export const measuredOpenRouterAuthError = {
  error: { message: 'No cookie auth credentials found', code: 401 },
};

/** Cloudflare request body: `input:{state,questions}` without model inside input. */
export const measuredCloudflareModelId = 'typesafe/jev';

/**
 * Cloudflare success envelope version field: unmeasured.
 * Default fixture keeps `model` absent so parse → `not_observable`.
 */
export const cloudflareSuccessFixture = {
  success: true,
  errors: [],
  result: {
    answers: {
      domain: {
        choice: 'infra',
        confidence: 0.99,
        probabilities: { infra: 0.993333, app: 0.003333, other: 0.003334 },
      },
      complexity: { score: 1.2, probabilities: [0.05, 0.7, 0.25] },
      safe: { noul: 0.82 },
    },
    usage: { input_tokens: 474, output_tokens: 76 },
  },
};

export const measuredCloudflareApiError = {
  success: false,
  errors: [{ code: 10000, message: 'Authentication error' }],
  result: null,
};

export const measuredState = {
  title: 'Measured fixture PR about a broker',
  summary: 'Synthetic reconstruction of the 2026-09-22 live probe state object',
};
