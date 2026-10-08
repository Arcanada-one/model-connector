/** Exact USD nanounits; catalogue Float estimates are not strict spend authority. */
export const MONEY_SCALE = 1_000_000_000n;
export function moneyUnits(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,9})?$/.test(value)) throw new Error('Invalid exact money');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * MONEY_SCALE + BigInt(fraction.padEnd(9, '0'));
}
export function pricedUnits(
  input: number,
  output: number,
  inputRate: string,
  outputRate: string,
): bigint {
  if (![input, output].every((v) => Number.isSafeInteger(v) && v >= 0))
    throw new Error('Invalid observed tokens');
  const numerator = BigInt(input) * moneyUnits(inputRate) + BigInt(output) * moneyUnits(outputRate);
  return (numerator + 999_999n) / 1_000_000n;
}
export function moneyJson(units: bigint): number {
  if (units < 0n) throw new Error('Negative money');
  const text = `${units / MONEY_SCALE}.${(units % MONEY_SCALE).toString().padStart(9, '0')}`;
  const result = Number(text);
  if (!Number.isFinite(result) || moneyUnits(result.toFixed(9)) !== units)
    throw new Error('Money cannot be represented by consumer contract');
  return result;
}
export function utcPeriods(at: Date) {
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid admission time');
  const y = at.getUTCFullYear(),
    m = at.getUTCMonth(),
    d = at.getUTCDate();
  return {
    dayStart: new Date(Date.UTC(y, m, d)),
    dayEnd: new Date(Date.UTC(y, m, d + 1)),
    monthStart: new Date(Date.UTC(y, m, 1)),
    monthEnd: new Date(Date.UTC(y, m + 1, 1)),
  };
}
