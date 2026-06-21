const SECRET_KEY = /token|secret|password|authorization|api[_-]?key/i;

export function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.slice(0, 200);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export class OpsBotClient {
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly send: (event: unknown) => Promise<void>,
    private readonly dedupWindowMs: number,
  ) {}

  async emit(event: Record<string, unknown>, now = Date.now()): Promise<boolean> {
    const key = JSON.stringify(redact(event));
    const previous = this.sent.get(key);
    if (previous !== undefined && now - previous < this.dedupWindowMs) return false;
    await this.send(redact(event));
    this.sent.set(key, now);
    return true;
  }
}

export function createOpsBotSender(url: string, token: string) {
  return async (event: unknown): Promise<void> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`Ops Bot delivery failed: ${response.status}`);
  };
}
