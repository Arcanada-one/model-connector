export class LatencyWindow {
  private state: 'healthy' | 'degraded' = 'healthy';
  private degradedCount = 0;
  private recoveredCount = 0;
  private frozenBaseline: number | null = null;

  constructor(private readonly config: {
    minimumSamples: number;
    degradeMultiplier: number;
    degradeDeltaMs: number;
    degradeWindows: number;
    recoverMultiplier: number;
    recoverWindows: number;
  }) {}

  observe(samples: number[], baselineMs: number | null) {
    const effectiveBaseline = this.frozenBaseline ?? baselineMs;
    if (samples.length < this.config.minimumSamples || effectiveBaseline === null) {
      return { state: this.state, p95Ms: null, baselineMs: effectiveBaseline };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const degradeAt = Math.max(effectiveBaseline * this.config.degradeMultiplier, effectiveBaseline + this.config.degradeDeltaMs);
    if (this.state === 'healthy') {
      this.degradedCount = p95 > degradeAt ? this.degradedCount + 1 : 0;
      if (this.degradedCount >= this.config.degradeWindows) {
        this.state = 'degraded';
        this.frozenBaseline = effectiveBaseline;
      }
    } else {
      this.recoveredCount = p95 <= effectiveBaseline * this.config.recoverMultiplier ? this.recoveredCount + 1 : 0;
      if (this.recoveredCount >= this.config.recoverWindows) {
        this.state = 'healthy';
        this.frozenBaseline = null;
        this.degradedCount = 0;
      }
    }
    return { state: this.state, p95Ms: p95, baselineMs: effectiveBaseline };
  }
}
