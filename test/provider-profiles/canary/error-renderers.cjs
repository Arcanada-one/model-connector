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
const { DeepSeekConnector } = require('../../../dist/src/connectors/deepseek/deepseek.connector');
const { JevConnector } = require('../../../dist/src/connectors/jev/jev.connector');
// Typed test-only exposure of the real protected adapter methods.
class AzureProbe extends AzureOpenAiConnector {
  /** @param {number} status @param {string} body */
  formatProbe(status, body) { return super.formatHttpErrorMessage(status, body); }
}
class PerplexityProbe extends PerplexityConnector {
  /** @param {number} status @param {string} body @param {Headers} headers */
  parseProbe(status, body, headers) { return super.parseHttpError(status, body, headers); }
}
class DeepSeekProbe extends DeepSeekConnector {
  /** @param {Response} response */
  readJson(response) { return super.readResponseJson(response); }
}
class JevProbe extends JevConnector {
  /** @param {Response} response */
  readJson(response) { return super.readResponseJson(response); }
}
const secret = ['synthetic', 'canary', 'credential'].join('-');
providerKeyContext.run({ provider: 'deepseek', apiKey: secret }, () => {
  const azure = new AzureProbe();
  const perplexity = new PerplexityProbe();
  for (let offset = 480; offset <= 520; offset++) {
    const body = 'x'.repeat(offset) + secret;
    const expected = ('x'.repeat(offset) + '[REDACTED]').slice(0, 500);
    assert.equal(azure.formatProbe(401, body), expected);
    assert.equal(
      azure.formatProbe(401, JSON.stringify({ error: { code: secret, message: body } })),
      '[REDACTED]: ' + 'x'.repeat(offset) + '[REDACTED]',
    );
    for (const status of [401, 403, 422, 429, 500])
      assert.equal(perplexity.parseProbe(status, body, new Headers()).message, expected);
    assert.equal(
      perplexity.parseProbe(422, JSON.stringify({ detail: secret }), new Headers()).details,
      '[REDACTED]',
    );
  }
});
async function checkJsonReaders() {
  /** @type {Array<[string, DeepSeekProbe | JevProbe]>} */
  const readers = [
    ['deepseek', new DeepSeekProbe()],
    ['typesafe-jev', new JevProbe()],
  ];
  for (const [provider, connector] of readers) {
    await providerKeyContext.run({ provider, apiKey: secret }, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(connector.readJson(new Response(secret)), {
          name: 'SyntaxError', message: 'Invalid upstream JSON response',
        });
      }
      assert.deepEqual(await connector.readJson(new Response(JSON.stringify({ echo: secret }))), {
        echo: '[REDACTED]',
      });
    });
  }
  console.log('VERIFIED: 41 boundary offsets; safe Base/JEV JSON readers; no upstream call');
}
checkJsonReaders().catch((error) => { console.error(error); process.exitCode = 1; });
