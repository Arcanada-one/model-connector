export class ModelConnectorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly repairToken?: string,
    /** Optional Bearer API key for authenticated endpoints (e.g. /connectors/catalog). */
    private readonly apiKey?: string,
  ) {}

  health() { return this.get('/health'); }
  ready() { return this.get('/health/ready'); }
  metrics() { return this.get('/health/metrics'); }
  connectors() { return this.get('/health/connectors'); }

  /**
   * Fetch the universal model catalog from the Model Connector.
   * Returns the raw JSON body — callers should validate with CatalogResponseSchema.
   */
  catalog(): Promise<unknown> { return this.get('/connectors/catalog'); }

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
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal });
    if (!response.ok) throw new Error(`Model Connector ${path} failed: ${response.status}`);
    return response.json();
  }
}
