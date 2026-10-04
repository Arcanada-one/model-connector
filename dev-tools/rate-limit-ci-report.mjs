import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SPEC = '/src/auth/rate-limit.integration.spec.ts';

export function verifyReport(report) {
  const suites = report?.testResults;
  if (report?.success !== true || report.numTotalTests !== 6 ||
      report.numPassedTests !== 6 || report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 || (report.numTodoTests ?? 0) !== 0 ||
      !Array.isArray(suites) || suites.length !== 1) {
    throw new Error('Expected exactly six passed rate-limit integration tests');
  }
  const suite = suites[0];
  if (typeof suite.name !== 'string' || !suite.name.endsWith(SPEC) ||
      suite.status !== 'passed' || !Array.isArray(suite.assertionResults) ||
      suite.assertionResults.length !== 6 ||
      suite.assertionResults.some((test) => test.status !== 'passed')) {
    throw new Error('Expected only the rate-limit integration spec, without skipped assertions');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyReport(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log('Six rate-limit integration assertions passed');
  } catch {
    // Report bodies can contain test inputs: never echo them on a refusal.
    console.error('Rate-limit integration report missing or not six passed assertions');
    process.exitCode = 1;
  }
}
