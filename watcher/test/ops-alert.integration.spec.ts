import { describe, expect, it, vi } from 'vitest';
import { Deadman } from '../src/deadman.js';
import { OpsBotClient, redact } from '../src/opsbot.client.js';

describe('alerting and independent deadman', () => {
  it('recursively redacts secrets and truncates error text', () => {
    const value = redact({ token: 'secret', nested: { authorization: 'bearer', message: 'x'.repeat(300) } });
    expect(JSON.stringify(value)).not.toContain('secret');
    expect((value as { nested: { message: string } }).nested.message.length).toBe(200);
  });

  it('deduplicates identical alerts', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = new OpsBotClient(send, 900000);
    const event = { provider: 'p', model: 'm', failure_class: 'unknown', audit_ref: 'a' };
    await client.emit(event, 1);
    await client.emit(event, 2);
    expect(send).toHaveBeenCalledOnce();
  });

  it('alerts after three missed heartbeats without recovery imports', async () => {
    const alert = vi.fn().mockResolvedValue(undefined);
    const deadman = new Deadman(30000, 3, alert);
    expect(await deadman.check('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:02:00.000Z'))).toBe(true);
    expect(alert).toHaveBeenCalledOnce();
  });
});
