const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface SafeValueLimits {
  readonly maxDepth: number;
  readonly maxWidth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxStringLength: number;
  readonly maxStringBytes: number;
  readonly allowFunction: boolean;
}

export class UnsafeValueError extends Error {
  constructor() {
    super('unsafe value');
    this.name = 'UnsafeValueError';
  }
}

interface InspectionState {
  nodes: number;
  readonly active: WeakSet<object>;
}

interface DataPropertyDescriptor extends PropertyDescriptor {
  readonly value: unknown;
}

const reject = (): never => {
  throw new UnsafeValueError();
};

const inspectString = (value: string, limits: SafeValueLimits): string => {
  if (
    value.length > limits.maxStringLength ||
    Buffer.byteLength(value, 'utf8') > limits.maxStringBytes
  ) {
    reject();
  }
  return value;
};

const requireDataDescriptor = (
  value: object,
  key: PropertyKey,
  requireEnumerable: boolean,
): DataPropertyDescriptor => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) throw new UnsafeValueError();
  if (!('value' in descriptor)) reject();
  if (descriptor.get || descriptor.set) reject();
  if (requireEnumerable && !descriptor.enumerable) reject();
  return descriptor as DataPropertyDescriptor;
};

const inspectArray = (
  value: unknown[],
  limits: SafeValueLimits,
  depth: number,
  state: InspectionState,
): unknown[] => {
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > limits.maxArrayLength) {
    reject();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol')) reject();
  const expectedKeys = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key as string))) {
    reject();
  }

  const clone: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = requireDataDescriptor(value, String(index), true);
    clone.push(inspectValueInternal(descriptor.value, limits, depth + 1, state));
  }
  return clone;
};

const inspectRecord = (
  value: object,
  limits: SafeValueLimits,
  depth: number,
  state: InspectionState,
): Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length > limits.maxWidth || keys.some((key) => typeof key === 'symbol')) reject();

  const clone: Record<string, unknown> = {};
  for (const rawKey of keys) {
    const key = rawKey as string;
    if (DANGEROUS_KEYS.has(key)) reject();
    const descriptor = requireDataDescriptor(value, key, true);
    clone[key] = inspectValueInternal(descriptor.value, limits, depth + 1, state);
  }
  return clone;
};

const inspectValueInternal = (
  value: unknown,
  limits: SafeValueLimits,
  depth: number,
  state: InspectionState,
): unknown => {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes || depth > limits.maxDepth) reject();

  if (typeof value === 'string') return inspectString(value, limits);
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject();
    return value;
  }
  if (typeof value === 'function' && limits.allowFunction) return value;
  if (typeof value !== 'object') reject();
  const objectValue = value as object;

  if (state.active.has(objectValue)) reject();
  state.active.add(objectValue);
  try {
    return Array.isArray(objectValue)
      ? inspectArray(objectValue, limits, depth, state)
      : inspectRecord(objectValue, limits, depth, state);
  } finally {
    state.active.delete(objectValue);
  }
};

export const inspectAndCloneSafeValue = (
  value: unknown,
  limits: SafeValueLimits,
): unknown =>
  inspectValueInternal(value, limits, 0, {
    nodes: 0,
    active: new WeakSet<object>(),
  });

export const isSafeRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const hasExactKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

export const serializedUtf8Bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
};
