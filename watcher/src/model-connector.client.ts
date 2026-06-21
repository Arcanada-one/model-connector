export class ModelConnectorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly repairToken?: string,
  ) {}

  health() { return this.get('/health'); }
  ready() { return this.get('/health/ready'); }
  metrics() { return this.get('/health/metrics'); }
  connectors() { return this.get('/health/connectors'); }

  async resetCircuit(connector: string, model: string): Promise<unknown> {
    if (!this.repairToken) throw new Error('watcher repair token unavailable');
    return this.request('/internal/watcher/circuit-breaker/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-watcher-repair-token': this.repairToken },
      body: JSON.stringify({ connector, model }),
    });
  }

  private get(path: string) {
    return this.request(path);
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, signal });
    if (!response.ok) throw new Error(`Model Connector ${path} failed: ${response.status}`);
    return response.json();
  }
}
