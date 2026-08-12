// CONN-1665 — known-gap guard for the BullMQ queue path.
//
// `ConnectorsService.enqueue()` + `ConnectorJobProcessor.process()` call
// `connector.execute()` DIRECTLY, bypassing every gate at the execute() choke
// point: CONN-0244 canUse(), the CONN-0239 modality gate, and the CONN-1665
// per-key policy + provider-key-override context (AsyncLocalStorage does not
// survive queue serialization). Today this path is dead code — no production
// code calls `enqueue(` or registers a connector on the processor.
//
// Consilium decision (CONN-1665): instead of adding a duplicate policy gate to
// the processor, this spec PINS the path as unreferenced. If a future task
// wires the queue path into production, this test fails and forces that task
// to either (a) route the queue path through ConnectorsService.execute() or
// (b) replicate ALL choke-point gates (policy included) in the processor.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(__dirname, '..');

function productionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.spec.ts') || entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

/** Files allowed to mention the pattern (definition sites). */
function findReferences(pattern: RegExp, allowedFiles: string[]): string[] {
  const hits: string[] = [];
  for (const file of productionSourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file);
    if (allowedFiles.includes(rel)) continue;
    const content = readFileSync(file, 'utf8');
    if (pattern.test(content)) hits.push(rel);
  }
  return hits;
}

describe('queue path stays dead (CONN-1665 known-gap guard)', () => {
  it('no production code calls ConnectorsService.enqueue()', () => {
    // `.enqueue(` — a method CALL; the definition in connectors.service.ts is allowed.
    const refs = findReferences(/\.enqueue\(/, ['connectors/connectors.service.ts']);
    expect(refs).toEqual([]);
  });

  it('no production code registers connectors on ConnectorJobProcessor', () => {
    // Without registerConnector() the processor can never execute anything —
    // the definition site itself is the only allowed mention.
    const refs = findReferences(/\.registerConnector\(/, ['queue/connector-job.processor.ts']);
    expect(refs).toEqual([]);
  });
});
