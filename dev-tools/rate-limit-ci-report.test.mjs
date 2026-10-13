import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyReport } from './rate-limit-ci-report.mjs';

function valid() {
  return {
    success: true, numTotalTests: 6, numPassedTests: 6,
    numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: '/app/src/auth/rate-limit.integration.spec.ts',
      status: 'passed', assertionResults: Array.from({ length: 6 }, () => ({ status: 'passed' })) }],
  };
}

test('accepts six real passed assertions from the exact spec', () => {
  assert.doesNotThrow(() => verifyReport(valid()));
});

/** @type {Array<[string, (report: ReturnType<typeof valid>) => void]>} */
const mutations = [
  ['empty selection', (r) => { r.numTotalTests = 0; r.testResults = []; }],
  ['one assertion missing', (r) => { r.numTotalTests = 5; r.numPassedTests = 5; }],
  ['skipped assertion', (r) => { r.testResults[0].assertionResults[0].status = 'pending'; }],
  ['failed assertion', (r) => { r.testResults[0].assertionResults[0].status = 'failed'; }],
  ['pending summary', (r) => { r.numPendingTests = 1; }],
  ['todo summary', (r) => { r.numTodoTests = 1; }],
  ['failure summary', (r) => { r.success = false; }],
  ['paid spec substitution', (r) => { r.testResults[0].name = '/app/src/connectors/image-generation/vertex/vertex-image.connector.integration.spec.ts'; }],
  ['additional spec', (r) => { r.testResults.push(structuredClone(r.testResults[0])); }],
  ['truncated assertion list', (r) => { r.testResults[0].assertionResults.pop(); }],
  ['malformed suite', (r) => { Reflect.set(r.testResults, '0', {}); }],
];
for (const [name, mutate] of mutations) {
  test(`refuses ${name}`, () => {
    const report = valid();
    mutate(report);
    assert.throws(() => verifyReport(report));
  });
}

test('refuses absent report', () => assert.throws(() => verifyReport(null)));
