// AUP-CACHE-006 (enforce0) — prompt-cache policy evaluator for the gateway.
//
// A PURE evaluator over the Messages API body AS IT WILL BE SENT (the bytes,
// not the caller's description of them) plus the routing context. It ports the
// layer derivation of the Prompt Layout Contract v1 (steps 1–11 of the
// contract's `derivation`) and applies:
//
//   • request rules — structure (breakpoints, TTLs), the model minimum
//     (PREFIX_BELOW_MINIMUM when caching is claimed and the prefix is too short
//     to be cached at all), and the contract's scan patterns before the last
//     breakpoint (secrets, tenant markers, identity, dynamic content);
//   • session rules — tools / system / model / L3 change inside a session
//     WITHOUT an explicit `session_epoch`, append-only history, parameter
//     changes, PREFIX_CHANGED events;
//   • gateway rules — tenant-scoped cache identity (a prefix first cached under
//     another API key, a session id owned by another API key);
//   • pre-warm detection (`max_tokens: 0`).
//
// The evaluator never rewrites the request. A violating request is REFUSED
// (enforce) or MARKED (observe) — the mode decides the action, never the
// finding; the finding is the same in both modes so switching the mode changes
// nothing about what is seen, only about what is let through.
//
// Reference: the program's `tools/prompt-cache/prefix_lint.py` (the oracle for
// `prefix_hash`; the replay fixture's hash is asserted equal in the spec) and
// the harness-side port `@arcanada/prompt-cache` (prompt-assembly, CACHE-005).
// Known divergences of a JavaScript port from the Python reference (length in
// UTF-16 units, `1.0` vs `1`, key order for non-BMP keys) are the same as
// documented there; no fixture reaches them.

import { createHash } from 'node:crypto';
import {
  ContractSeverity,
  PromptLayoutContract,
  resolveContractModel,
} from './prompt-layout-contract';

export type PolicyMode = 'off' | 'observe' | 'enforce';
export const POLICY_MODES: readonly PolicyMode[] = ['off', 'observe', 'enforce'];
export type ActiveMode = Exclude<PolicyMode, 'off'>;
export type PolicyVerdict = 'CONFORMANT' | 'VIOLATION' | 'UNDETERMINED' | 'NOT_CLAIMED';
export type PolicyAction = 'pass' | 'mark' | 'refuse';
export type FindingScope = 'request' | 'session' | 'gateway';
export type FindingLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'prefix' | 'request' | 'session';

export interface PolicyFinding {
  readonly code: string;
  readonly severity: ContractSeverity;
  readonly scope: FindingScope;
  readonly source: 'contract' | 'gateway';
  readonly layer: FindingLayer;
  /** Diagnostic text. NEVER carries request text: a scan hit names the pattern index, not the match. */
  readonly detail: string;
}

/** Codes the gateway adds on top of the contract (the contract does not know tenants). */
export const GATEWAY_CODES: Readonly<
  Record<string, { severity: ContractSeverity; scope: FindingScope; meaning: string }>
> = Object.freeze({
  CROSS_TENANT_PREFIX: {
    severity: 'error',
    scope: 'gateway',
    meaning:
      'the prefix_hash was first cached under another tenant (API key); cache identity is tenant-scoped',
  },
  SESSION_TENANT_MISMATCH: {
    severity: 'refusal',
    scope: 'gateway',
    meaning: 'the session_id is owned by another tenant (API key)',
  },
  PREFIX_HASH_CONFLICT: {
    severity: 'warning',
    scope: 'gateway',
    meaning:
      'the prefix_hash the caller claims differs from the one computed from the bytes (both recorded, held)',
  },
  TENANT_UNATTRIBUTED: {
    severity: 'warning',
    scope: 'gateway',
    meaning:
      'no routing context carried a tenant; the request is evaluated under the unattributed tenant',
  },
  REQUEST_UNREADABLE: {
    severity: 'undetermined',
    scope: 'gateway',
    meaning: 'the body is not a Messages API object; verdict UNDETERMINED',
  },
});

/** Contract codes this gateway does NOT evaluate (harness-side rules, lib0); reported, never silent. */
export const NOT_EVALUATED_CODES: readonly string[] = Object.freeze([
  'L3_GRAMMAR',
  'L3_KEY_NOT_ALLOWED',
  'DYN_UUID@L3',
]);

export const UNATTRIBUTED_TENANT = 'unattributed';

export interface PolicyContext {
  readonly tenantId: string | null;
  readonly sessionId?: string;
  readonly sessionEpoch?: string;
  /** The prefix_hash the caller's builder computed (the X-Arcanada-Prefix-Hash equivalent). */
  readonly prefixHashClaimed?: string;
}

export interface LayerHashes {
  readonly L0: string;
  readonly L1: string;
  readonly L2: string;
  readonly L3: string;
}

interface SessionBaseline {
  readonly epoch: string | null;
  readonly model: string | null;
  readonly toolDefs: ReadonlyMap<string, string>;
  readonly toolOrder: readonly string[];
  readonly layerHashes: LayerHashes;
  readonly paramsSig: string;
}

export interface SessionSnapshot {
  readonly baseline: SessionBaseline;
  readonly lastPrefixHash: string;
  readonly lastLayerHashes: LayerHashes;
  readonly lastMessages: readonly string[];
  readonly requestCount: number;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}

export interface PolicyStore {
  getSession(key: string): SessionSnapshot | undefined;
  setSession(key: string, snapshot: SessionSnapshot): void;
  prefixOwner(prefixHash: string): string | undefined;
  claimPrefix(prefixHash: string, tenantId: string, nowMs: number): void;
  sessionOwner(sessionId: string): string | undefined;
  claimSession(sessionId: string, tenantId: string, nowMs: number): void;
}

export interface SessionDecision {
  readonly id: string | null;
  readonly epoch: string | null;
  readonly request_index: number;
  readonly baseline: 'none' | 'new' | 'kept' | 'epoch_advanced';
  readonly prefix_changed: boolean;
  readonly changed_layers: readonly string[];
}

export interface PromptCachePolicyDecision {
  readonly schema: 'PromptCachePolicyDecision/v1';
  readonly decision_id: string;
  readonly contract: { readonly id: string; readonly digest: string };
  readonly mode: ActiveMode;
  readonly tenant: string;
  readonly caching_claimed: boolean;
  readonly verdict: PolicyVerdict;
  readonly action: PolicyAction;
  readonly findings: readonly PolicyFinding[];
  readonly not_evaluated: readonly string[];
  readonly model: string | null;
  readonly model_resolved: string | null;
  readonly min_prefix_tokens: number | null;
  readonly est_prefix_tokens: number | null;
  readonly prefix_hash: string | null;
  readonly layer_hashes: LayerHashes | null;
  readonly cache_identity: string | null;
  readonly prewarm: boolean;
  readonly session: SessionDecision;
  readonly evaluated_ms: number;
}

// ─── canonical JSON / hashing (parity with prefix_lint.py) ─────────────────

class CanonicalJsonError extends Error {
  constructor(reason: string) {
    super(`request is not canonicalisable: ${reason}`);
    this.name = 'CanonicalJsonError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `json.dumps(obj, sort_keys=True, separators=(',',':'), ensure_ascii=False)`. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new CanonicalJsonError(`unsupported value of type ${typeof value}`);
}

export function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Deep copy without any `cache_control` key (append-only comparison). */
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripCacheControl(entry));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key !== 'cache_control') out[key] = stripCacheControl(entry);
    }
    return out;
  }
  return value;
}

function textOfBlocks(blocks: readonly unknown[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (isRecord(block) && block.type === 'text') out.push(String(block.text ?? ''));
    else if (typeof block === 'string') out.push(block);
  }
  return out.join('\n');
}

/** All string leaves joined (tail scans over tool_use inputs / tool_results). */
function deepText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => deepText(entry)).join('\n');
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([, entry]) => deepText(entry))
      .join('\n');
  }
  return '';
}

function ttlOf(block: unknown): string | null {
  if (!isRecord(block)) return null;
  const cc = block.cache_control;
  if (!isRecord(cc)) return null;
  return typeof cc.ttl === 'string' ? cc.ttl : '5m';
}

function hasCacheControl(block: unknown): boolean {
  return isRecord(block) && 'cache_control' in block;
}

// ─── derivation (port of prefix_lint.derive) ───────────────────────────────

type PrefixLayer = 'L1' | 'L2' | 'L3';
const PREFIX_LAYERS: readonly PrefixLayer[] = ['L1', 'L2', 'L3'];

interface Breakpoint {
  readonly layer: 'L1' | 'L2' | 'L3' | 'L4';
  readonly ttl: string | null;
}

interface Derivation {
  readonly L0: readonly unknown[];
  readonly layers: Readonly<Record<PrefixLayer, readonly unknown[]>>;
  readonly L4: readonly unknown[];
  readonly breakpoints: readonly Breakpoint[];
  readonly explicitTotal: number;
  readonly systemIsString: boolean;
  readonly missing: readonly PrefixLayer[];
  readonly misplaced: readonly string[];
  readonly toolCc: number;
  readonly l4NotLast: number;
  readonly l4Breakpoints: number;
  readonly estPrefixTokens: number;
  readonly layerHashes: LayerHashes;
  readonly prefixHash: string;
  readonly prefixText: Readonly<Record<'L0' | PrefixLayer, string>>;
  readonly nonText: readonly { layer: PrefixLayer; type: string }[];
}

function derive(req: Record<string, unknown>): Derivation {
  const tools: readonly unknown[] = Array.isArray(req.tools) ? req.tools : [];
  const layers: Record<PrefixLayer, unknown[]> = { L1: [], L2: [], L3: [] };
  const breakpoints: Breakpoint[] = [];
  const missing: PrefixLayer[] = [];
  const misplaced: string[] = [];
  let explicitTotal = 0;

  const toolCc = tools.filter((tool) => hasCacheControl(tool)).length;
  explicitTotal += toolCc;

  const system = req.system;
  const systemIsString = typeof system === 'string';
  const blocks: readonly unknown[] = Array.isArray(system) ? system : [];
  const parts: unknown[][] = [];
  let current: unknown[] = [];
  for (const block of blocks) {
    current.push(block);
    if (hasCacheControl(block)) {
      parts.push(current);
      current = [];
    }
  }
  const tail = current;
  explicitTotal += parts.length;

  let l3Placement: 'system-tail' | 'messages-head' | null = null;
  let m0Rest: unknown[] = [];
  if (systemIsString) {
    missing.push(...PREFIX_LAYERS);
    layers.L1 = [{ type: 'text', text: system }];
  } else {
    parts.slice(0, 3).forEach((part, index) => {
      const layer = PREFIX_LAYERS[index];
      layers[layer] = part;
      breakpoints.push({ layer, ttl: ttlOf(part[part.length - 1]) });
    });
    if (parts.length >= 3) {
      l3Placement = 'system-tail';
      if (parts.length > 3)
        misplaced.push(`${parts.length - 3} extra system partition(s) after L3`);
      if (tail.length > 0) misplaced.push(`${tail.length} system block(s) after the L3 breakpoint`);
    } else if (parts.length === 2 && tail.length === 0) {
      const messages: readonly unknown[] = Array.isArray(req.messages) ? req.messages : [];
      const first = messages[0];
      let head: unknown[] = [];
      let rest: unknown[] = [];
      if (isRecord(first) && first.role === 'user' && Array.isArray(first.content)) {
        let found = false;
        for (const block of first.content) {
          if (found) {
            rest.push(block);
            continue;
          }
          head.push(block);
          if (hasCacheControl(block)) found = true;
        }
        if (!found) {
          head = [];
          rest = [...first.content];
        }
      }
      if (head.length > 0) {
        layers.L3 = head;
        l3Placement = 'messages-head';
        breakpoints.push({ layer: 'L3', ttl: ttlOf(head[head.length - 1]) });
        explicitTotal += 1;
        m0Rest = rest;
      } else {
        missing.push('L3');
      }
    } else {
      for (let index = parts.length; index < 3; index += 1) missing.push(PREFIX_LAYERS[index]);
      if (tail.length > 0) {
        const slot = PREFIX_LAYERS[Math.min(parts.length, 2)];
        if (layers[slot].length === 0) layers[slot] = tail; // scanned as prefix, not derived
      }
    }
  }

  // L4
  let messages: unknown[] = Array.isArray(req.messages) ? [...req.messages] : [];
  if (l3Placement === 'messages-head' && messages.length > 0 && isRecord(messages[0])) {
    const first = { ...messages[0], content: m0Rest };
    messages = first.content.length === 0 ? messages.slice(1) : [first, ...messages.slice(1)];
  }
  const l4Cc: { mi: number; bi: number; ttl: string | null }[] = [];
  messages.forEach((message, mi) => {
    const content = isRecord(message) ? message.content : undefined;
    if (Array.isArray(content)) {
      content.forEach((block, bi) => {
        if (hasCacheControl(block)) l4Cc.push({ mi, bi, ttl: ttlOf(block) });
      });
    }
  });
  explicitTotal += l4Cc.length;
  const lastMessage = messages[messages.length - 1];
  const last =
    isRecord(lastMessage) && Array.isArray(lastMessage.content) && lastMessage.content.length > 0
      ? { mi: messages.length - 1, bi: lastMessage.content.length - 1 }
      : null;
  const notLast =
    l4Cc.length <= 1
      ? l4Cc.filter((cc) => last === null || cc.mi !== last.mi || cc.bi !== last.bi)
      : l4Cc;
  if (l4Cc.length === 1 && last !== null && l4Cc[0].mi === last.mi && l4Cc[0].bi === last.bi) {
    breakpoints.push({ layer: 'L4', ttl: l4Cc[0].ttl });
  }

  const l0Canonical = canonicalJson(tools);
  const prefixText = {
    L0: l0Canonical,
    L1: textOfBlocks(layers.L1),
    L2: textOfBlocks(layers.L2),
    L3: textOfBlocks(layers.L3),
  };
  const prefixChars =
    l0Canonical.length + prefixText.L1.length + prefixText.L2.length + prefixText.L3.length;
  const layerHashes: LayerHashes = {
    L0: sha256Text(l0Canonical),
    L1: sha256Text(canonicalJson(layers.L1)),
    L2: sha256Text(canonicalJson(layers.L2)),
    L3: sha256Text(canonicalJson(layers.L3)),
  };
  const prefixHash = sha256Text(
    canonicalJson({ tools, L1: layers.L1, L2: layers.L2, L3: layers.L3 }),
  );
  const nonText: { layer: PrefixLayer; type: string }[] = [];
  for (const layer of PREFIX_LAYERS) {
    for (const block of layers[layer]) {
      if (isRecord(block) && block.type !== 'text') {
        nonText.push({ layer, type: String(block.type) });
      }
    }
  }

  return {
    L0: tools,
    layers,
    L4: messages,
    breakpoints,
    explicitTotal,
    systemIsString,
    missing,
    misplaced,
    toolCc,
    l4NotLast: notLast.length,
    l4Breakpoints: l4Cc.length,
    estPrefixTokens: estTokens(prefixChars),
    layerHashes,
    prefixHash,
    prefixText,
    nonText,
  };
}

// ─── findings ──────────────────────────────────────────────────────────────

function contractFinding(
  contract: PromptLayoutContract,
  code: string,
  layer: FindingLayer,
  detail: string,
): PolicyFinding {
  const entry = contract.violationCodes[code];
  if (!entry) throw new Error(`code ${code} is not in the vendored contract`);
  return { code, severity: entry.severity, scope: entry.scope, source: 'contract', layer, detail };
}

function gatewayFinding(code: string, layer: FindingLayer, detail: string): PolicyFinding {
  const entry = GATEWAY_CODES[code];
  return { code, severity: entry.severity, scope: entry.scope, source: 'gateway', layer, detail };
}

function requestFindings(
  contract: PromptLayoutContract,
  d: Derivation,
  modelKey: string | null,
  minPrefix: number | null,
): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  const f = (code: string, layer: FindingLayer, detail: string) =>
    out.push(contractFinding(contract, code, layer, detail));

  if (d.systemIsString) {
    f('SYSTEM_NOT_BLOCKS', 'L1', 'system is a string; breakpoints cannot be placed');
  }
  for (const layer of d.missing) {
    f('MISSING_BREAKPOINT', layer, `end of ${layer} carries no cache_control`);
  }
  if (d.explicitTotal > contract.maxExplicitBreakpoints) {
    f(
      'BREAKPOINT_EXCESS',
      'request',
      `${d.explicitTotal} explicit breakpoints > ${contract.maxExplicitBreakpoints}`,
    );
  }
  if (d.toolCc > 0) {
    f('BREAKPOINT_MISPLACED', 'L0', `${d.toolCc} tool definition(s) carry cache_control`);
  }
  for (const detail of d.misplaced) f('BREAKPOINT_MISPLACED', 'L3', detail);
  if (d.l4NotLast > 0) {
    f(
      'L4_BREAKPOINT_NOT_LAST',
      'L4',
      `${d.l4Breakpoints} L4 breakpoint(s); ${d.l4NotLast} not on the last content block of the last message`,
    );
  }
  for (const bp of d.breakpoints) {
    if (bp.ttl !== null && !contract.ttlValues.includes(bp.ttl)) {
      f(
        'TTL_INVALID',
        bp.layer,
        `ttl ${JSON.stringify(bp.ttl)} not in ${contract.ttlValues.join('/')}`,
      );
    }
  }
  const rank: Record<string, number> = { '1h': 2, '5m': 1 };
  const ranked = d.breakpoints.filter((bp) => bp.ttl !== null && bp.ttl in rank);
  for (let index = 1; index < ranked.length; index += 1) {
    const prev = ranked[index - 1];
    const cur = ranked[index];
    if (rank[cur.ttl as string] > rank[prev.ttl as string]) {
      f(
        'TTL_ORDER',
        cur.layer,
        `${cur.layer} ttl 1h follows ${prev.layer} ttl 5m (1h blocks must precede 5m blocks)`,
      );
    }
  }
  if (modelKey === null) {
    f('MODEL_UNKNOWN', 'request', 'model not in the contract table; minimum prefix unknown');
  } else if (minPrefix !== null && d.estPrefixTokens < minPrefix) {
    f(
      'PREFIX_BELOW_MINIMUM',
      'prefix',
      `est_tokens_chars4=${d.estPrefixTokens} < ${minPrefix} for ${modelKey} (silently uncached)`,
    );
  }
  for (const entry of d.nonText) {
    f(
      'NON_TEXT_IN_PREFIX',
      entry.layer,
      `block type ${JSON.stringify(entry.type)} inside the stable prefix`,
    );
  }

  const names = new Map<string, number>();
  for (const tool of d.L0) {
    if (isRecord(tool) && typeof tool.name === 'string') {
      names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
    }
  }
  for (const [name, count] of names) {
    if (count > 1) f('TOOL_DUPLICATE', 'L0', `tool ${JSON.stringify(name)} defined ${count} times`);
  }

  // Scans over the stable prefix. DYN_UUID is not evaluated on L3 (the L3
  // grammar allows a work-item UUID under an allowed key; that grammar is a
  // harness-side rule — see NOT_EVALUATED_CODES).
  for (const rule of contract.scanRules) {
    const scanLayers: readonly ('L0' | PrefixLayer)[] =
      rule.code === 'DYN_UUID' ? ['L0', 'L1', 'L2'] : ['L0', 'L1', 'L2', 'L3'];
    for (const layer of scanLayers) {
      const text = d.prefixText[layer];
      if (text.length === 0) continue;
      rule.patterns.forEach((pattern, index) => {
        if (pattern.test(text)) {
          f(rule.code, layer, `pattern #${index} of ${rule.code} matched in ${layer}`);
        }
      });
    }
  }
  const secretRule = contract.scanRules.find((rule) => rule.code === 'SECRET_IN_PREFIX');
  if (secretRule && d.L4.length > 0) {
    const tailText = deepText(d.L4);
    secretRule.patterns.forEach((pattern, index) => {
      if (pattern.test(tailText)) {
        f(
          'SECRET_IN_TAIL',
          'L4',
          `secret pattern #${index} after the last breakpoint (not cached; must not be there either)`,
        );
      }
    });
  }
  return out;
}

function toolDefs(tools: readonly unknown[]): { defs: Map<string, string>; order: string[] } {
  const defs = new Map<string, string>();
  const order: string[] = [];
  tools.forEach((tool, index) => {
    const name = isRecord(tool) && typeof tool.name === 'string' ? tool.name : `#${index}`;
    order.push(name);
    defs.set(name, canonicalJson(stripCacheControl(tool)));
  });
  return { defs, order };
}

function paramsSignature(req: Record<string, unknown>): string {
  const outputConfig = isRecord(req.output_config) ? req.output_config : undefined;
  return canonicalJson({
    tool_choice: req.tool_choice ?? null,
    thinking: req.thinking ?? null,
    effort: outputConfig?.effort ?? null,
  });
}

function messageDigests(req: Record<string, unknown>): string[] {
  const messages: readonly unknown[] = Array.isArray(req.messages) ? req.messages : [];
  return messages.map((message) => canonicalJson(stripCacheControl(message)));
}

function sameDefs(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, def] of a) if (b.get(name) !== def) return false;
  return true;
}

function sessionFindings(
  contract: PromptLayoutContract,
  req: Record<string, unknown>,
  d: Derivation,
  baseline: SessionBaseline,
  index: number,
): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  const f = (code: string, layer: FindingLayer, detail: string) =>
    out.push(contractFinding(contract, code, layer, detail));
  const model = typeof req.model === 'string' ? req.model : null;
  if (model !== baseline.model) {
    f(
      'SESSION_MODEL_CHANGED',
      'request',
      `request ${index}: model differs from the session's first request (no session_epoch given)`,
    );
  }
  const { defs, order } = toolDefs(d.L0);
  if (!sameDefs(defs, baseline.toolDefs)) {
    f(
      'SESSION_TOOLS_CHANGED',
      'L0',
      `request ${index}: tool set or a tool definition differs from the first request (no session_epoch given)`,
    );
  } else if (order.join(' ') !== baseline.toolOrder.join(' ')) {
    f('TOOL_ORDER_NONDETERMINISTIC', 'L0', `request ${index}: same tools, different order`);
  }
  for (const layer of ['L1', 'L2'] as const) {
    if (d.layerHashes[layer] !== baseline.layerHashes[layer]) {
      f(
        'SESSION_SYSTEM_CHANGED',
        layer,
        `request ${index}: ${layer} hash differs from the first request (no session_epoch given)`,
      );
    }
  }
  if (d.layerHashes.L3 !== baseline.layerHashes.L3) {
    f(
      'SESSION_L3_CHANGED',
      'L3',
      `request ${index}: L3 hash differs from the first request (no session_epoch given)`,
    );
  }
  if (paramsSignature(req) !== baseline.paramsSig) {
    f(
      'PARAMS_CHANGED',
      'request',
      `request ${index}: tool_choice/thinking/effort differ from the first request (messages-level invalidation)`,
    );
  }
  return out;
}

function appendOnlyFinding(
  contract: PromptLayoutContract,
  previous: readonly string[],
  current: readonly string[],
  index: number,
): PolicyFinding | null {
  if (current.length < previous.length) {
    return contractFinding(
      contract,
      'L4_NOT_APPEND_ONLY',
      'L4',
      `request ${index}: previous messages (${previous.length}) are not a prefix of current (${current.length})`,
    );
  }
  for (let i = 0; i < previous.length; i += 1) {
    if (previous[i] !== current[i]) {
      return contractFinding(
        contract,
        'L4_NOT_APPEND_ONLY',
        'L4',
        `request ${index}: message ${i} was rewritten`,
      );
    }
  }
  return null;
}

// ─── verdict / action ──────────────────────────────────────────────────────

function worstSeverity(findings: readonly PolicyFinding[]): ContractSeverity | null {
  let worst: ContractSeverity | null = null;
  const rank: Record<ContractSeverity, number> = {
    refusal: 4,
    error: 3,
    undetermined: 2,
    warning: 1,
  };
  for (const finding of findings) {
    if (worst === null || rank[finding.severity] > rank[worst]) worst = finding.severity;
  }
  return worst;
}

export function verdictOf(
  findings: readonly PolicyFinding[],
): Exclude<PolicyVerdict, 'NOT_CLAIMED'> {
  const worst = worstSeverity(findings);
  if (worst === 'refusal' || worst === 'error') return 'VIOLATION';
  if (worst === 'undetermined') return 'UNDETERMINED';
  return 'CONFORMANT';
}

/**
 * The mode decides the ACTION, never the finding. `observe` marks and lets
 * through; `enforce` refuses a VIOLATION. UNDETERMINED (an unknown model) is a
 * third verdict — marked in both modes, refused in neither, because refusing
 * what could not be evaluated would collapse it into a failure.
 */
export function actionOf(mode: ActiveMode, verdict: PolicyVerdict): PolicyAction {
  if (verdict === 'NOT_CLAIMED' || verdict === 'CONFORMANT') return 'pass';
  if (verdict === 'UNDETERMINED') return 'mark';
  return mode === 'enforce' ? 'refuse' : 'mark';
}

// ─── in-memory store ───────────────────────────────────────────────────────

interface Owner {
  readonly tenantId: string;
  readonly atMs: number;
}

export interface InMemoryPolicyStoreOptions {
  readonly sessionIdleMs?: number;
  readonly maxSessions?: number;
  readonly maxOwners?: number;
}

/** Bounded process-local state: idle sessions expire; owner maps evict oldest-first. */
export class InMemoryPolicyStore implements PolicyStore {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly prefixOwners = new Map<string, Owner>();
  private readonly sessionOwners = new Map<string, Owner>();
  private readonly sessionIdleMs: number;
  private readonly maxSessions: number;
  private readonly maxOwners: number;

  constructor(options: InMemoryPolicyStoreOptions = {}) {
    this.sessionIdleMs = options.sessionIdleMs ?? 2 * 60 * 60_000;
    this.maxSessions = options.maxSessions ?? 10_000;
    this.maxOwners = options.maxOwners ?? 50_000;
  }

  get size(): { sessions: number; prefixes: number; sessionIds: number } {
    return {
      sessions: this.sessions.size,
      prefixes: this.prefixOwners.size,
      sessionIds: this.sessionOwners.size,
    };
  }

  getSession(key: string): SessionSnapshot | undefined {
    return this.sessions.get(key);
  }

  setSession(key: string, snapshot: SessionSnapshot): void {
    this.sessions.delete(key);
    this.sessions.set(key, snapshot);
    if (this.sessions.size > this.maxSessions) this.sweepSessions(snapshot.lastSeenMs);
  }

  sweepSessions(nowMs: number): number {
    let removed = 0;
    for (const [key, snapshot] of this.sessions) {
      if (nowMs - snapshot.lastSeenMs > this.sessionIdleMs) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      removed += 1;
    }
    return removed;
  }

  prefixOwner(prefixHash: string): string | undefined {
    return this.prefixOwners.get(prefixHash)?.tenantId;
  }

  claimPrefix(prefixHash: string, tenantId: string, nowMs: number): void {
    if (this.prefixOwners.has(prefixHash)) return;
    this.prefixOwners.set(prefixHash, { tenantId, atMs: nowMs });
    trimOldest(this.prefixOwners, this.maxOwners);
  }

  sessionOwner(sessionId: string): string | undefined {
    return this.sessionOwners.get(sessionId)?.tenantId;
  }

  claimSession(sessionId: string, tenantId: string, nowMs: number): void {
    if (this.sessionOwners.has(sessionId)) return;
    this.sessionOwners.set(sessionId, { tenantId, atMs: nowMs });
    trimOldest(this.sessionOwners, this.maxOwners);
  }
}

function trimOldest(map: Map<string, Owner>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// ─── evaluation ────────────────────────────────────────────────────────────

export interface EvaluateOptions {
  readonly contract: PromptLayoutContract;
  readonly mode: ActiveMode;
  readonly store: PolicyStore;
  readonly decisionId: string;
  readonly nowMs?: number;
}

const NO_SESSION: SessionDecision = Object.freeze({
  id: null,
  epoch: null,
  request_index: 0,
  baseline: 'none',
  prefix_changed: false,
  changed_layers: [],
});

function cachingClaimed(req: Record<string, unknown>, ctx: PolicyContext): boolean {
  if (ctx.prefixHashClaimed !== undefined) return true;
  const tools: readonly unknown[] = Array.isArray(req.tools) ? req.tools : [];
  if (tools.some((tool) => hasCacheControl(tool))) return true;
  const system: readonly unknown[] = Array.isArray(req.system) ? req.system : [];
  if (system.some((block) => hasCacheControl(block))) return true;
  const messages: readonly unknown[] = Array.isArray(req.messages) ? req.messages : [];
  for (const message of messages) {
    const content = isRecord(message) ? message.content : undefined;
    if (Array.isArray(content) && content.some((block) => hasCacheControl(block))) return true;
  }
  return false;
}

interface Unevaluated {
  readonly caching_claimed: boolean;
  readonly verdict: 'NOT_CLAIMED' | 'UNDETERMINED';
  readonly action: 'pass' | 'mark';
  readonly findings: readonly PolicyFinding[];
  readonly model: string | null;
  readonly prewarm: boolean;
}

/**
 * Evaluate one request. Pure apart from the store: state is written only for a
 * request that is let through (a refused request never becomes a baseline).
 */
export function evaluatePromptCachePolicy(
  body: unknown,
  ctx: PolicyContext,
  options: EvaluateOptions,
): PromptCachePolicyDecision {
  const started = process.hrtime.bigint();
  const nowMs = options.nowMs ?? Date.now();
  const { contract, mode, store } = options;
  const tenant = ctx.tenantId ?? UNATTRIBUTED_TENANT;
  const base = {
    schema: 'PromptCachePolicyDecision/v1' as const,
    decision_id: options.decisionId,
    contract: { id: contract.id, digest: contract.digest },
    mode,
    tenant,
    not_evaluated: NOT_EVALUATED_CODES,
  };
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  const unevaluated = (u: Unevaluated): PromptCachePolicyDecision => ({
    ...base,
    ...u,
    model_resolved: null,
    min_prefix_tokens: null,
    est_prefix_tokens: null,
    prefix_hash: null,
    layer_hashes: null,
    cache_identity: null,
    session: NO_SESSION,
    evaluated_ms: elapsed(),
  });

  if (!isRecord(body)) {
    return unevaluated({
      caching_claimed: false,
      verdict: 'UNDETERMINED',
      action: 'mark',
      findings: [gatewayFinding('REQUEST_UNREADABLE', 'request', 'body is not an object')],
      model: null,
      prewarm: false,
    });
  }

  const model = typeof body.model === 'string' ? body.model : null;
  const prewarm = body.max_tokens === 0;
  if (!cachingClaimed(body, ctx)) {
    return unevaluated({
      caching_claimed: false,
      verdict: 'NOT_CLAIMED',
      action: 'pass',
      findings: [],
      model,
      prewarm,
    });
  }

  let d: Derivation;
  try {
    d = derive(body);
  } catch (err) {
    return unevaluated({
      caching_claimed: true,
      verdict: 'UNDETERMINED',
      action: 'mark',
      findings: [gatewayFinding('REQUEST_UNREADABLE', 'request', (err as Error).message)],
      model,
      prewarm,
    });
  }

  const resolved = resolveContractModel(contract, model);
  const modelKey = resolved?.key ?? null;
  const minPrefix = resolved?.model.min_prefix_tokens ?? null;
  const findings: PolicyFinding[] = requestFindings(contract, d, modelKey, minPrefix);

  if (ctx.tenantId === null) {
    findings.push(
      gatewayFinding('TENANT_UNATTRIBUTED', 'request', 'no routing context carried a tenant'),
    );
  }
  if (ctx.prefixHashClaimed !== undefined && ctx.prefixHashClaimed !== d.prefixHash) {
    findings.push(
      gatewayFinding(
        'PREFIX_HASH_CONFLICT',
        'prefix',
        `claimed ${ctx.prefixHashClaimed.slice(0, 23)} differs from computed ${d.prefixHash.slice(0, 23)}`,
      ),
    );
  }
  const prefixOwner = store.prefixOwner(d.prefixHash);
  if (prefixOwner !== undefined && prefixOwner !== tenant) {
    findings.push(
      gatewayFinding(
        'CROSS_TENANT_PREFIX',
        'prefix',
        'prefix_hash first cached under another tenant',
      ),
    );
  }

  // Session rules (tenant-scoped key; a session id belongs to one tenant).
  let session: SessionDecision = NO_SESSION;
  let nextSnapshot: SessionSnapshot | null = null;
  const sessionId = ctx.sessionId;
  if (sessionId !== undefined) {
    const owner = store.sessionOwner(sessionId);
    if (owner !== undefined && owner !== tenant) {
      findings.push(
        gatewayFinding(
          'SESSION_TENANT_MISMATCH',
          'session',
          'session_id is owned by another tenant',
        ),
      );
      session = { ...NO_SESSION, id: sessionId, epoch: ctx.sessionEpoch ?? null };
    } else {
      const key = `${tenant} ${sessionId}`;
      const previous = store.getSession(key);
      const messages = messageDigests(body);
      const { defs, order } = toolDefs(d.L0);
      const epochAdvanced =
        previous !== undefined &&
        ctx.sessionEpoch !== undefined &&
        ctx.sessionEpoch !== previous.baseline.epoch;
      const index = previous ? previous.requestCount : 0;
      let baselineKind: SessionDecision['baseline'];
      let baseline: SessionBaseline;
      if (previous === undefined || epochAdvanced) {
        baselineKind = previous === undefined ? 'new' : 'epoch_advanced';
        baseline = {
          epoch: ctx.sessionEpoch ?? null,
          model,
          toolDefs: defs,
          toolOrder: order,
          layerHashes: d.layerHashes,
          paramsSig: paramsSignature(body),
        };
      } else {
        baselineKind = 'kept';
        baseline = previous.baseline;
        findings.push(...sessionFindings(contract, body, d, baseline, index));
      }
      let prefixChanged = false;
      const changedLayers: string[] = [];
      if (previous !== undefined) {
        const appendFinding = epochAdvanced
          ? null
          : appendOnlyFinding(contract, previous.lastMessages, messages, index);
        if (appendFinding) findings.push(appendFinding);
        prefixChanged = previous.lastPrefixHash !== d.prefixHash;
        for (const layer of ['L0', 'L1', 'L2', 'L3'] as const) {
          if (previous.lastLayerHashes[layer] !== d.layerHashes[layer]) changedLayers.push(layer);
        }
      }
      session = {
        id: sessionId,
        epoch: baseline.epoch,
        request_index: index,
        baseline: baselineKind,
        prefix_changed: prefixChanged,
        changed_layers: changedLayers,
      };
      nextSnapshot = {
        baseline,
        lastPrefixHash: d.prefixHash,
        lastLayerHashes: d.layerHashes,
        lastMessages: messages,
        requestCount: index + 1,
        firstSeenMs: previous?.firstSeenMs ?? nowMs,
        lastSeenMs: nowMs,
      };
    }
  }

  const verdict = verdictOf(findings);
  const action = actionOf(mode, verdict);
  if (action !== 'refuse') {
    store.claimPrefix(d.prefixHash, tenant, nowMs);
    if (sessionId !== undefined && nextSnapshot !== null) {
      store.claimSession(sessionId, tenant, nowMs);
      store.setSession(`${tenant} ${sessionId}`, nextSnapshot);
    }
  }

  return {
    ...base,
    caching_claimed: true,
    verdict,
    action,
    findings,
    model,
    model_resolved: modelKey,
    min_prefix_tokens: minPrefix,
    est_prefix_tokens: d.estPrefixTokens,
    prefix_hash: d.prefixHash,
    layer_hashes: d.layerHashes,
    cache_identity: sha256Text(`${tenant}\n${d.prefixHash}`),
    prewarm,
    session,
    evaluated_ms: elapsed(),
  };
}
