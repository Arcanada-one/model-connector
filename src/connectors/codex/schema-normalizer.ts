const MAX_DEPTH = 5;
const MAX_SIZE_BYTES = 64 * 1024;

export class SchemaNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaNormalizationError';
  }
}

export function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(schema);
  if (json.length > MAX_SIZE_BYTES) {
    throw new SchemaNormalizationError(
      `schema exceeds max size ${MAX_SIZE_BYTES} bytes (got ${json.length})`,
    );
  }
  if (Array.isArray((schema as { anyOf?: unknown }).anyOf)) {
    throw new SchemaNormalizationError('top-level anyOf is not allowed');
  }
  if (containsSelfRef(schema)) {
    throw new SchemaNormalizationError('inline self-references ($ref:"#") are not allowed');
  }
  return walk(schema, 0) as Record<string, unknown>;
}

function containsSelfRef(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(containsSelfRef);
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.$ref === '#') return true;
    return Object.values(obj).some(containsSelfRef);
  }
  return false;
}

function walk(node: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new SchemaNormalizationError(`schema depth exceeds ${MAX_DEPTH}`);
  }
  if (Array.isArray(node)) {
    return node.map((n) => walk(n, depth + 1));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }

  const obj = { ...(node as Record<string, unknown>) };

  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    const propsKeys = Object.keys(obj.properties as Record<string, unknown>);
    obj.additionalProperties = false;
    obj.required = propsKeys;
    const newProps: Record<string, unknown> = {};
    for (const k of propsKeys) {
      newProps[k] = walk((obj.properties as Record<string, unknown>)[k], depth + 1);
    }
    obj.properties = newProps;
  } else if (obj.type === 'array' && obj.items) {
    obj.items = walk(obj.items, depth + 1);
  }

  return obj;
}
