export class JsonSanitizeError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonSanitizeError';
  }
}

export interface SanitizeResult {
  json: unknown;
  wasClean: boolean;
  sanitized: string;
}

/**
 * Extract and validate JSON from LLM response text.
 *
 * Steps:
 * 1. Trim + strip BOM
 * 2. Try direct JSON.parse
 * 3. Strip markdown code fences
 * 4. Extract first JSON object/array by bracket matching
 * 5. Parse extracted substring
 */
export function sanitizeJsonResponse(raw: string): SanitizeResult {
  // Step 1: trim + strip BOM
  const cleaned = raw.replace(/^\uFEFF/, '').trim();

  if (!cleaned) {
    throw new JsonSanitizeError('Empty response', raw);
  }

  // Step 2: try direct parse
  try {
    const json = JSON.parse(cleaned);
    return { json, wasClean: true, sanitized: cleaned };
  } catch {
    // continue to sanitization
  }

  // Step 3: strip markdown code fences (skip regex on very large payloads to avoid backtracking)
  let stripped = cleaned;
  if (cleaned.length > 512_000) {
    // Skip fence regex for large payloads, jump straight to bracket extraction
    stripped = cleaned;
  } else {
    // Fence regex is safe for payloads under 512KB
  }
  const fenceMatch =
    cleaned.length <= 512_000 ? cleaned.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?\s*```$/) : null;
  if (fenceMatch) {
    stripped = fenceMatch[1].trim();
    try {
      const json = JSON.parse(stripped);
      return { json, wasClean: false, sanitized: stripped };
    } catch {
      // continue
    }
  }

  // Also handle fences that don't span the entire string
  const innerFenceMatch =
    cleaned.length <= 512_000 ? cleaned.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n?\s*```/) : null;
  if (innerFenceMatch) {
    stripped = innerFenceMatch[1].trim();
    try {
      const json = JSON.parse(stripped);
      return { json, wasClean: false, sanitized: stripped };
    } catch {
      // continue
    }
  }

  // Step 4: extract JSON by finding first { or [ and matching last } or ]
  const firstObj = cleaned.indexOf('{');
  const firstArr = cleaned.indexOf('[');
  let startIdx: number;
  let endChar: string;

  if (firstObj === -1 && firstArr === -1) {
    throw new JsonSanitizeError('No JSON object or array found', raw);
  }

  if (firstObj === -1) {
    startIdx = firstArr;
    endChar = ']';
  } else if (firstArr === -1) {
    startIdx = firstObj;
    endChar = '}';
  } else if (firstObj < firstArr) {
    startIdx = firstObj;
    endChar = '}';
  } else {
    startIdx = firstArr;
    endChar = ']';
  }

  const lastEnd = cleaned.lastIndexOf(endChar);
  if (lastEnd <= startIdx) {
    throw new JsonSanitizeError('Unmatched JSON brackets', raw);
  }

  const extracted = cleaned.slice(startIdx, lastEnd + 1);

  // Step 5: parse extracted
  try {
    const json = JSON.parse(extracted);
    return { json, wasClean: false, sanitized: extracted };
  } catch {
    throw new JsonSanitizeError('Failed to parse extracted JSON', raw);
  }
}
