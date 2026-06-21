import { describe, expect, it } from 'vitest';
import { LatencyWindow } from '../src/latency-window.js';
import { RateWindow } from '../src/rate-window.js';

describe('statistical evaluators', () => {
  it('requires sample floors and consecutive rate windows', () => {
    const window = new RateWindow({ minimumSamples: 20, degradeRatio: 0.25, degradeWindows: 2, recoverRatio: 0.1, recoverWindows: 3 });
    expect(window.observe(4, 10).state).toBe('healthy');
    expect(window.observe(6, 20).state).toBe('healthy');
    expect(window.observe(7, 20).state).toBe('degraded');
    expect(window.observe(1, 20).state).toBe('degraded');
    expect(window.observe(1, 20).state).toBe('degraded');
    expect(window.observe(1, 20).state).toBe('healthy');
  });

  it('requires three degraded latency windows and freezes baseline', () => {
    const window = new LatencyWindow({ minimumSamples: 20, degradeMultiplier: 2, degradeDeltaMs: 1000, degradeWindows: 3, recoverMultiplier: 1.5, recoverWindows: 3 });
    expect(window.observe(Array(20).fill(500), 500).state).toBe('healthy');
    expect(window.observe(Array(20).fill(1600), 500).state).toBe('healthy');
    expect(window.observe(Array(20).fill(1600), 500).state).toBe('healthy');
    const degraded = window.observe(Array(20).fill(1600), 500);
    expect(degraded.state).toBe('degraded');
    expect(degraded.baselineMs).toBe(500);
  });
});
