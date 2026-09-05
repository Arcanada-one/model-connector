// AUP-CACHE-006 (enforce0) — the Prompt Layout Contract v1 as a VENDORED,
// DIGEST-PINNED artefact with a fail-closed loader.
//
// `contract/prompt-layout.v1.json` is a byte-identical copy of the program's
// `contracts/prompt-cache/prompt-layout.v1.json` (Arcanada Universal Program,
// portion AUP-CACHE-001:layout0). The gateway IMPORTS the contract's rules —
// the model table (minimum cacheable prefix per family), the scan patterns
// (secret / tenant / identity / dynamic-content detectors), the violation
// codes with their severities — instead of restating them in code: a rule
// that lives twice drifts twice (the card's own failure condition: "the rules
// duplicate the contract instead of importing its schema").
//
// The copy is pinned by sha256 (PROMPT_LAYOUT_CONTRACT_SHA256) and its SHAPE is
// validated at boot, the same pattern as Muneral's vendored status map
// (MUN-0041): a malformed, edited or unrecognised artefact is a startup
// failure, never a silent fallback to "no rules". Whoever updates the contract
// updates the digest in the same commit, and the receipt records both.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The schema this loader is written against. A different schema is refused. */
export const PROMPT_LAYOUT_CONTRACT_SCHEMA = 'PromptLayoutContract/v1';
export const PROMPT_LAYOUT_CONTRACT_ID = 'prompt-layout.v1';
/** sha256 of the vendored bytes (= the program's contract file at import time). */
export const PROMPT_LAYOUT_CONTRACT_SHA256 =
  '678dfa2e9e6c0493a51b432a6be09edabc06fa15e4f423c518f1c1e629c6e06a';
export const PROMPT_LAYOUT_CONTRACT_PATH = join(__dirname, 'contract', 'prompt-layout.v1.json');

export type ContractSeverity = 'error' | 'refusal' | 'warning' | 'undetermined';
export type ContractScope = 'request' | 'session';

const SEVERITIES: readonly ContractSeverity[] = ['error', 'refusal', 'warning', 'undetermined'];
const SCOPES: readonly ContractScope[] = ['request', 'session'];
const REQUIRED_VERDICTS = ['CONFORMANT', 'VIOLATION', 'UNDETERMINED'] as const;

export interface ContractModel {
  readonly family: string;
  readonly min_prefix_tokens: number;
  readonly read_multiplier: number;
}

export interface ContractViolationCode {
  readonly severity: ContractSeverity;
  readonly scope: ContractScope;
  readonly meaning: string;
}

export interface CompiledScanRule {
  readonly code: string;
  /** Compiled from the contract's Python `re` sources; no `g` flag (stateless `.test`). */
  readonly patterns: readonly RegExp[];
}

export interface PromptLayoutContract {
  readonly schema: string;
  readonly id: string;
  /** `sha256:<hex>` of the vendored bytes. */
  readonly digest: string;
  readonly models: Readonly<Record<string, ContractModel>>;
  readonly maxExplicitBreakpoints: number;
  readonly ttlValues: readonly string[];
  readonly scanRules: readonly CompiledScanRule[];
  readonly violationCodes: Readonly<Record<string, ContractViolationCode>>;
  readonly verdicts: readonly string[];
}

export class PromptLayoutContractError extends Error {
  constructor(reason: string) {
    super(`prompt-layout contract is unusable: ${reason}`);
    this.name = 'PromptLayoutContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Port one contract pattern (Python `re` syntax) to a JavaScript RegExp.
 * Only the leading `(?i)` inline flag is supported — the contract's `_note`
 * documents it as the sole flag in use; any other inline flag is refused so a
 * pattern never silently compiles to something weaker than the contract meant.
 */
export function compileContractPattern(source: string): RegExp {
  let body = source;
  let flags = '';
  if (body.startsWith('(?i)')) {
    body = body.slice(4);
    flags = 'i';
  }
  if (/\(\?[a-zA-Z]+\)/.test(body)) {
    throw new PromptLayoutContractError(
      `pattern ${JSON.stringify(source)} uses an inline flag this port does not support`,
    );
  }
  try {
    return new RegExp(body, flags);
  } catch (err) {
    throw new PromptLayoutContractError(
      `pattern ${JSON.stringify(source)} does not compile: ${(err as Error).message}`,
    );
  }
}

/**
 * Validate the vendored artefact (bytes → digest → shape) and return it typed.
 *
 * Exported so the tests can feed deliberately broken artefacts and prove each
 * refusal, instead of only asserting that the good one loads. `expectedSha256`
 * defaults to the pinned digest; a test may pass the digest of its own mutant
 * to reach the shape checks behind the digest gate.
 */
export function loadPromptLayoutContract(
  bytes: Buffer | string,
  expectedSha256: string = PROMPT_LAYOUT_CONTRACT_SHA256,
): PromptLayoutContract {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const digestHex = createHash('sha256').update(buffer).digest('hex');
  if (digestHex !== expectedSha256) {
    throw new PromptLayoutContractError(
      `digest sha256:${digestHex} does not match the pinned sha256:${expectedSha256}`,
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new PromptLayoutContractError(`it is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(candidate)) throw new PromptLayoutContractError('it is not a JSON object');

  if (candidate.schema !== PROMPT_LAYOUT_CONTRACT_SCHEMA) {
    throw new PromptLayoutContractError(
      `schema is ${JSON.stringify(candidate.schema)}, expected ${JSON.stringify(PROMPT_LAYOUT_CONTRACT_SCHEMA)}`,
    );
  }
  if (candidate.id !== PROMPT_LAYOUT_CONTRACT_ID) {
    throw new PromptLayoutContractError(
      `id is ${JSON.stringify(candidate.id)}, expected ${JSON.stringify(PROMPT_LAYOUT_CONTRACT_ID)}`,
    );
  }

  const models = candidate.models;
  if (!isRecord(models) || Object.keys(models).length === 0) {
    throw new PromptLayoutContractError('models is missing or empty');
  }
  const typedModels: Record<string, ContractModel> = {};
  for (const [key, entry] of Object.entries(models)) {
    if (!isRecord(entry)) throw new PromptLayoutContractError(`models.${key} is not an object`);
    if (typeof entry.family !== 'string' || entry.family.length === 0) {
      throw new PromptLayoutContractError(`models.${key}.family is not a non-empty string`);
    }
    if (!isPositiveInteger(entry.min_prefix_tokens)) {
      throw new PromptLayoutContractError(
        `models.${key}.min_prefix_tokens is not a positive integer`,
      );
    }
    if (typeof entry.read_multiplier !== 'number' || !(entry.read_multiplier > 0)) {
      throw new PromptLayoutContractError(`models.${key}.read_multiplier is not a positive number`);
    }
    typedModels[key] = {
      family: entry.family,
      min_prefix_tokens: entry.min_prefix_tokens,
      read_multiplier: entry.read_multiplier,
    };
  }

  const facts = candidate.official_facts;
  if (!isRecord(facts)) throw new PromptLayoutContractError('official_facts is missing');
  if (!isPositiveInteger(facts.max_explicit_breakpoints)) {
    throw new PromptLayoutContractError(
      'official_facts.max_explicit_breakpoints is not a positive integer',
    );
  }
  const ttlValues = facts.ttl_values;
  if (
    !Array.isArray(ttlValues) ||
    ttlValues.length === 0 ||
    !ttlValues.every((v) => typeof v === 'string' && v.length > 0)
  ) {
    throw new PromptLayoutContractError(
      'official_facts.ttl_values is not a non-empty string array',
    );
  }

  const codes = candidate.violation_codes;
  if (!isRecord(codes) || Object.keys(codes).length === 0) {
    throw new PromptLayoutContractError('violation_codes is missing or empty');
  }
  const typedCodes: Record<string, ContractViolationCode> = {};
  for (const [code, entry] of Object.entries(codes)) {
    if (!isRecord(entry))
      throw new PromptLayoutContractError(`violation_codes.${code} is not an object`);
    if (!SEVERITIES.includes(entry.severity as ContractSeverity)) {
      throw new PromptLayoutContractError(
        `violation_codes.${code}.severity ${JSON.stringify(entry.severity)} is not one of ${SEVERITIES.join('/')}`,
      );
    }
    if (!SCOPES.includes(entry.scope as ContractScope)) {
      throw new PromptLayoutContractError(
        `violation_codes.${code}.scope ${JSON.stringify(entry.scope)} is not one of ${SCOPES.join('/')}`,
      );
    }
    if (typeof entry.meaning !== 'string' || entry.meaning.length === 0) {
      throw new PromptLayoutContractError(
        `violation_codes.${code}.meaning is not a non-empty string`,
      );
    }
    typedCodes[code] = {
      severity: entry.severity as ContractSeverity,
      scope: entry.scope as ContractScope,
      meaning: entry.meaning,
    };
  }

  const scans = candidate.scan_patterns;
  if (!isRecord(scans)) throw new PromptLayoutContractError('scan_patterns is missing');
  const scanRules: CompiledScanRule[] = [];
  for (const [code, sources] of Object.entries(scans)) {
    if (code === '_note') continue;
    if (!(code in typedCodes)) {
      throw new PromptLayoutContractError(`scan_patterns.${code} has no entry in violation_codes`);
    }
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new PromptLayoutContractError(`scan_patterns.${code} is not a non-empty array`);
    }
    const patterns: RegExp[] = [];
    for (const source of sources) {
      if (typeof source !== 'string' || source.length === 0) {
        throw new PromptLayoutContractError(`scan_patterns.${code} contains a non-string pattern`);
      }
      patterns.push(compileContractPattern(source));
    }
    scanRules.push({ code, patterns });
  }
  if (scanRules.length === 0)
    throw new PromptLayoutContractError('scan_patterns declares no rules');
  if (!scanRules.some((rule) => rule.code === 'SECRET_IN_PREFIX')) {
    throw new PromptLayoutContractError('scan_patterns lacks SECRET_IN_PREFIX');
  }
  if (!scanRules.some((rule) => rule.code === 'TENANT_IN_PREFIX')) {
    throw new PromptLayoutContractError('scan_patterns lacks TENANT_IN_PREFIX');
  }

  const verdicts = candidate.verdicts;
  if (!isRecord(verdicts)) throw new PromptLayoutContractError('verdicts is missing');
  for (const verdict of REQUIRED_VERDICTS) {
    if (!(verdict in verdicts)) {
      throw new PromptLayoutContractError(`verdicts lacks ${verdict}`);
    }
  }

  return Object.freeze({
    schema: PROMPT_LAYOUT_CONTRACT_SCHEMA,
    id: PROMPT_LAYOUT_CONTRACT_ID,
    digest: `sha256:${digestHex}`,
    models: Object.freeze(typedModels),
    maxExplicitBreakpoints: facts.max_explicit_breakpoints,
    ttlValues: Object.freeze([...(ttlValues as string[])]),
    scanRules: Object.freeze(scanRules),
    violationCodes: Object.freeze(typedCodes),
    verdicts: Object.freeze(Object.keys(verdicts)),
  });
}

let vendored: PromptLayoutContract | undefined;

/** The vendored contract, read once from disk and validated against the pinned digest. */
export function loadVendoredPromptLayoutContract(): PromptLayoutContract {
  if (!vendored) vendored = loadPromptLayoutContract(readFileSync(PROMPT_LAYOUT_CONTRACT_PATH));
  return vendored;
}

/**
 * Longest-prefix model resolution (contract `model_resolution`): dated ids such
 * as `claude-haiku-4-5-20251001` resolve to their family row; no match → null
 * (the caller reports MODEL_UNKNOWN and verdict UNDETERMINED, never CONFORMANT).
 */
export function resolveContractModel(
  contract: PromptLayoutContract,
  model: unknown,
): { key: string; model: ContractModel } | null {
  if (typeof model !== 'string') return null;
  let best: string | null = null;
  for (const key of Object.keys(contract.models)) {
    if (model === key || model.startsWith(key)) {
      if (best === null || key.length > best.length) best = key;
    }
  }
  return best === null ? null : { key: best, model: contract.models[best] };
}
