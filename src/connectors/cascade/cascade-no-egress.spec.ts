// CONN-0223 — No-egress invariant enforcement for the cascade router layer.
//
// PRD (VERD-0056 AC-4) + plan Appendix A S2 require that the cascade module
// contains NO direct HTTP calls — all network I/O must be delegated to
// ConnectorsService.  This spec enforces that invariant at the source level
// by grepping the cascade directory for forbidden egress call-syntax and
// FAILING if any match is found.
//
// Forbidden patterns (call-syntax, not comments):
//   fetch(            — native Fetch API / node-fetch
//   axios             — axios (any method)
//   http.request(     — Node.js http module
//   https.request(    — Node.js https module
//   got(              — got library
//   undici            — undici pool / fetch
//   .get(             — http-client chained get (ambiguous; excluded from axis)
//   .post(            — http-client chained post (ambiguous; excluded from axis)
//
// Note: import statements for the above are also forbidden (importing axios in
// the cascade layer implies call-site potential even if not called yet).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASCADE_DIR = __dirname;

// Source files only — exclude spec files from the egress check (specs may mock
// these calls to verify the invariant itself does not regress).
const SOURCE_FILES = readdirSync(CASCADE_DIR).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
);

// Patterns that indicate direct HTTP egress inside the cascade layer.
// Each entry is [label, regex].  The regex must not match inside comment lines
// (lines starting with optional whitespace then // or *).
const EGRESS_PATTERNS: Array<[string, RegExp]> = [
  ['fetch(', /\bfetch\s*\(/],
  ['axios import/use', /\baxios\b/],
  ['http.request(', /\bhttp\.request\s*\(/],
  ['https.request(', /\bhttps\.request\s*\(/],
  ['got(', /\bgot\s*\(/],
  ['undici', /\bundici\b/],
];

function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\*)/.test(line);
}

function findEgressViolations(
  source: string,
  filePath: string,
): Array<{ file: string; line: number; text: string; pattern: string }> {
  const violations: Array<{ file: string; line: number; text: string; pattern: string }> = [];
  const lines = source.split('\n');

  for (const [label, regex] of EGRESS_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (regex.test(line)) {
        violations.push({ file: filePath, line: i + 1, text: line.trim(), pattern: label });
      }
    }
  }

  return violations;
}

describe('cascade no-egress invariant (CONN-0223 PRD AC-4 + plan Appendix A S2)', () => {
  it('cascade source files contain no direct HTTP egress calls', () => {
    const allViolations: Array<{ file: string; line: number; text: string; pattern: string }> = [];

    for (const file of SOURCE_FILES) {
      const filePath = join(CASCADE_DIR, file);
      const source = readFileSync(filePath, 'utf-8');
      const violations = findEgressViolations(source, file);
      allViolations.push(...violations);
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${v.file}:${v.line} [${v.pattern}] — ${v.text}`)
        .join('\n');
      expect.fail(
        `No-egress invariant violated — direct HTTP call-syntax found in cascade source:\n${report}\n\n` +
          `All HTTP must be delegated through ConnectorsService (see PRD AC-4 + plan Appendix A S2).`,
      );
    }

    // Positive assertion: the invariant passed
    expect(allViolations).toHaveLength(0);
  });

  it('would catch a hypothetical axios.get() violation (guard self-test)', () => {
    // Synthesize a source that contains a forbidden egress call and verify that
    // findEgressViolations catches it.  This ensures the guard itself is not dead code.
    const synthetic = `
import { Injectable } from '@nestjs/common';

@Injectable()
export class BadCascadeService {
  async fetchData(url: string) {
    return axios.get(url);  // forbidden egress
  }
}
`;
    const violations = findEgressViolations(synthetic, 'synthetic-bad.ts');
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.pattern === 'axios import/use')).toBe(true);
  });

  it('would catch a hypothetical fetch( violation (guard self-test)', () => {
    const synthetic = `
export async function callExternal(url: string) {
  const res = await fetch(url);
  return res.json();
}
`;
    const violations = findEgressViolations(synthetic, 'synthetic-fetch.ts');
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.pattern === 'fetch(')).toBe(true);
  });

  it('comments describing forbidden patterns are not flagged', () => {
    // The legitimate comment at cascade-router.service.ts:2 must not trigger
    const comment = `// NO fetch/axios/http in this file — all HTTP is delegated to ConnectorsService.`;
    const violations = findEgressViolations(comment, 'comment-only.ts');
    expect(violations).toHaveLength(0);
  });
});
