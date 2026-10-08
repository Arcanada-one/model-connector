/** Deterministic process canary of compiled provider-specific error rendering.
 * No network, DB, real credentials or provider calls. Native producer pins bytes.
 */
const assert = require('node:assert/strict');
const {
  AzureOpenAiConnector,
} = require('../../../dist/src/connectors/azure-openai/azure-openai.connector');
const {
  PerplexityConnector,
} = require('../../../dist/src/connectors/perplexity/perplexity.connector');
const { providerKeyContext } = require('../../../dist/src/policy/provider-key.context');
const secret = ['synthetic', 'canary', 'credential'].join('-');
providerKeyContext.run({ provider: 'deepseek', apiKey: secret }, () => {
  const azure = new AzureOpenAiConnector();
  const perplexity = new PerplexityConnector();
  for (let offset = 480; offset <= 520; offset++) {
    const body = 'x'.repeat(offset) + secret;
    const expected = ('x'.repeat(offset) + '[REDACTED]').slice(0, 500);
    assert.equal(azure.formatHttpErrorMessage(401, body), expected);
    assert.equal(
      azure.formatHttpErrorMessage(401, JSON.stringify({ error: { code: secret, message: body } })),
      '[REDACTED]: ' + 'x'.repeat(offset) + '[REDACTED]',
    );
    for (const status of [401, 403, 422, 429, 500])
      assert.equal(perplexity.parseHttpError(status, body, new Headers()).message, expected);
    assert.equal(
      perplexity.parseHttpError(422, JSON.stringify({ detail: secret }), new Headers()).details,
      '[REDACTED]',
    );
  }
});
console.log(
  'VERIFIED: 41 boundary offsets; Azure renderer and all Perplexity error branches; no upstream call',
);
