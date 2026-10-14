import { describe, expect, it } from 'vitest';
import { moneyJson, moneyUnits, pricedUnits, utcPeriods } from './money';

describe('supplier exact money and UTC admission periods', () => {
  it('adds decimal values without binary float drift', () => {
    expect(moneyUnits('0.1') + moneyUnits('0.2')).toBe(moneyUnits('0.3'));
    expect(moneyJson(moneyUnits('0.3'))).toBe(0.3);
  });
  it('reserves by rounding upward at the nanounit boundary', () => {
    expect(pricedUnits(1, 0, '0.000000001', '0')).toBe(1n);
    expect(pricedUnits(1024, 128, '1', '2')).toBe(1_280_000n);
  });
  it.each(['NaN', '-1', '1e2', '0.0000000001', '01', 'Infinity'])(
    'refuses malformed exact money %s',
    (value) => {
      expect(() => moneyUnits(value)).toThrow();
    },
  );
  it('computes leap-month and UTC boundaries independently of timezone offsets', () => {
    const p = utcPeriods(new Date('2028-03-01T01:00:00+03:00'));
    expect(p.dayStart.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(p.dayEnd.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    expect(p.monthStart.toISOString()).toBe('2028-02-01T00:00:00.000Z');
    expect(p.monthEnd.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });
});
