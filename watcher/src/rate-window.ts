export interface WindowResult {
  state: 'healthy' | 'degraded';
  ratio: number | null;
}

export class RateWindow {
  private state: 'healthy' | 'degraded' = 'healthy';
  private degradedCount = 0;
  private recoveredCount = 0;

  constructor(private readonly config: {
    minimumSamples: number;
    degradeRatio: number;
    degradeWindows: number;
    recoverRatio: number;
    recoverWindows: number;
  }) {}

  observe(errors: number, samples: number): WindowResult {
    if (samples < this.config.minimumSamples) return { state: this.state, ratio: null };
    const ratio = errors / samples;
    if (this.state === 'healthy') {
      this.degradedCount = ratio >= this.config.degradeRatio ? this.degradedCount + 1 : 0;
      if (this.degradedCount >= this.config.degradeWindows) {
        this.state = 'degraded';
        this.recoveredCount = 0;
      }
    } else {
      this.recoveredCount = ratio <= this.config.recoverRatio ? this.recoveredCount + 1 : 0;
      if (this.recoveredCount >= this.config.recoverWindows) {
        this.state = 'healthy';
        this.degradedCount = 0;
      }
    }
    return { state: this.state, ratio };
  }
}
