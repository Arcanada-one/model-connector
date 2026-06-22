/**
 * Unit tests for evidence-analyzer.js filterToWindow function (CONN-0230).
 * Verifies that pre-window records are excluded from FP/sample/flap metrics.
 */

import { describe, expect, it } from 'vitest';

// evidence-analyzer.js is a plain CJS-style ESM script.
// Import the exported filterToWindow helper directly.
// The file uses top-level `import` so it is ESM — vitest can import it.
import { filterToWindow } from '../deploy/evidence-analyzer.js';

function makeRecord(timestamp: string, provider = 'openrouter', model = 'model-a') {
  return { timestamp, provider, model, failure_class: 'circuit_open' };
}

describe('filterToWindow', () => {
  const BEFORE = '2026-06-01T00:00:00.000Z';   // pre-window
  const START  = '2026-06-10T00:00:00.000Z';   // window start
  const DURING = '2026-06-15T00:00:00.000Z';   // in-window
  const END    = '2026-06-20T00:00:00.000Z';   // window end
  const AFTER  = '2026-06-25T00:00:00.000Z';   // post-window

  const records = [
    makeRecord(BEFORE),
    makeRecord(START),
    makeRecord(DURING),
    makeRecord(END),
    makeRecord(AFTER),
  ];

  const startTs = new Date(START).getTime();
  const endTs   = new Date(END).getTime();

  it('drops records before startTs', () => {
    const filtered = filterToWindow(records, startTs, endTs);
    const timestamps = filtered.map((r: { timestamp: string }) => r.timestamp);
    expect(timestamps).not.toContain(BEFORE);
  });

  it('keeps records at exactly startTs', () => {
    const filtered = filterToWindow(records, startTs, endTs);
    const timestamps = filtered.map((r: { timestamp: string }) => r.timestamp);
    expect(timestamps).toContain(START);
  });

  it('keeps records within the window', () => {
    const filtered = filterToWindow(records, startTs, endTs);
    const timestamps = filtered.map((r: { timestamp: string }) => r.timestamp);
    expect(timestamps).toContain(DURING);
  });

  it('keeps records at exactly endTs', () => {
    const filtered = filterToWindow(records, startTs, endTs);
    const timestamps = filtered.map((r: { timestamp: string }) => r.timestamp);
    expect(timestamps).toContain(END);
  });

  it('drops records after endTs', () => {
    const filtered = filterToWindow(records, startTs, endTs);
    const timestamps = filtered.map((r: { timestamp: string }) => r.timestamp);
    expect(timestamps).not.toContain(AFTER);
  });

  it('returns all records when startTs and endTs are null (no scoping)', () => {
    const filtered = filterToWindow(records, null, null);
    expect(filtered).toHaveLength(records.length);
  });

  it('filters only by start when endTs is null', () => {
    const filtered = filterToWindow(records, startTs, null);
    expect(filtered.map((r: { timestamp: string }) => r.timestamp)).not.toContain(BEFORE);
    expect(filtered.map((r: { timestamp: string }) => r.timestamp)).toContain(AFTER);
  });

  it('drops records with invalid timestamps', () => {
    const withBad = [...records, { timestamp: 'not-a-date', provider: 'x', model: 'y', failure_class: 'unknown' }];
    const filtered = filterToWindow(withBad, startTs, endTs);
    expect(filtered.every((r: { timestamp: string }) => !isNaN(new Date(r.timestamp).getTime()))).toBe(true);
  });

  it('pre-window stale FP records (38 failures before shadow start) are excluded', () => {
    // Simulates the 38 stale failure_class:unknown records mentioned in CONN-0230
    const shadowStart = new Date('2026-06-10T00:00:00.000Z').getTime();
    const stale = Array.from({ length: 38 }, (_, i) =>
      makeRecord(new Date(shadowStart - (i + 1) * 60000).toISOString())
    );
    const postFix = [makeRecord('2026-06-10T01:00:00.000Z'), makeRecord('2026-06-10T02:00:00.000Z')];
    const all = [...stale, ...postFix];
    const filtered = filterToWindow(all, shadowStart, null);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r: { timestamp: string }) => r.timestamp)).toEqual(
      expect.arrayContaining(['2026-06-10T01:00:00.000Z', '2026-06-10T02:00:00.000Z'])
    );
  });
});
