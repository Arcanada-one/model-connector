import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrimeExposureEnvelope, type EnvelopeHold } from './envelope-mirror';

const NOW = '2026-10-13T12:00:00.000Z';
const from = () => new Date('2026-10-13T00:00:00.000Z');
const to = () => new Date('2026-10-14T00:00:00.000Z');
const authority = {
  ledgerId: '00000000-0000-4000-8000-000000000001',
  accountId: 'synthetic-account',
  ownerProfileId: 'synthetic-client',
};
const page = () => ({
  schema: 'MCProfileSpendEvents/v1',
  ...authority,
  after: '0',
  through: '0',
  watermark: '0',
  observedAt: NOW,
  events: [],
});
const direct: EnvelopeHold = {
  physicalId: 'synthetic-physical-attempt',
  runId: 'synthetic-run',
  admittedAt: NOW,
  route: 'direct',
  state: 'dispatch_started',
  heldNano: '100',
  observedNano: null,
  reconciliation: 'NOT_MEASURED',
};
const mirror = () => new PrimeExposureEnvelope(authority, [direct], {});

describe('Prime envelope time input stays fail closed (offline only)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['invalid from', new Date(NaN), to()],
    ['invalid to', from(), new Date(NaN)],
    ['both invalid', new Date(NaN), new Date(NaN)],
    ['empty', new Date(NOW), new Date(NOW)],
    ['reversed', new Date(NOW), from()],
  ] as const)('refuses %s before a budgeted dispatch', (_name, start, end) => {
    const subject = mirror();
    subject.import(page());
    const dispatch = vi.fn();
    const attempt = () => {
      subject.admit(1n, 100n, start, end);
      dispatch();
    };
    expect(attempt).toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    // Refusal cannot erase held spend or poison a subsequent valid window.
    expect(subject.exposure(from(), to())).toBe(100n);
    expect(() => subject.admit(1n, 101n, from(), to())).not.toThrow();
  });

  it('invalid clock cannot import a fresh-looking page or unpause admission', () => {
    const subject = mirror();
    subject.import(page());
    expect(() => subject.import(page(), new Date(NaN))).toThrow();
    expect(() => subject.admit(1n, 101n, from(), to())).toThrow();
    subject.import(page());
    expect(() => subject.admit(1n, 101n, from(), to())).not.toThrow();
  });

  it('valid windows count held exposure and preserve the real 429 cap', () => {
    const subject = mirror();
    subject.import(page());
    expect(subject.exposure(from(), to())).toBe(100n);
    expect(() => subject.admit(1n, 100n, from(), to())).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    expect(() => subject.admit(1n, 101n, from(), to())).not.toThrow();
  });

  it.each([-60001, 5001])('stale/future page delta %sms stays refused', (delta) => {
    const subject = mirror();
    expect(() =>
      subject.import({ ...page(), observedAt: new Date(Date.now() + delta).toISOString() }),
    ).toThrow();
    expect(() => subject.admit(1n, 101n, from(), to())).toThrow();
  });
});
