export class Deadman {
  constructor(
    private readonly heartbeatIntervalMs: number,
    private readonly missedHeartbeats: number,
    private readonly alert: () => Promise<void>,
  ) {}

  async check(heartbeatAt: string, now = Date.now()): Promise<boolean> {
    if (now - Date.parse(heartbeatAt) < this.heartbeatIntervalMs * this.missedHeartbeats) return false;
    await this.alert();
    return true;
  }
}
