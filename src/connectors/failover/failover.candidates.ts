// CONN-0243 — build the free-first, DeepSeek-first failover candidate list from
// connector capabilities (in-memory only — NO getCatalog/getStatus network probes,
// consilium R-F3). Anti-fabrication: candidates come only from models the connectors
// actually declare in getCapabilities() (the same source getCatalog derives `models`
// from); live availability is enforced by the failover loop (a dead/limited provider
// returns 429/5xx/circuit_open → the chain advances).

import { ConnectorCapabilities, ProviderModelMeta } from '../interfaces/connector.interface';
import { ModelModality } from '../dto/catalog.dto';
import { CascadeCandidate, validateFreeBeforePaid } from '../cascade/cascade.profiles';

/** Model ids that mean "no specific model — use the free-first chain". */
const AUTO_ALIASES = new Set(['', 'auto', 'failover', 'free', 'default']);

export interface BuildFailoverCandidatesInput {
  capabilities: ConnectorCapabilities[];
  /** The model the client asked for (OpenAI `model` field). Treated as a preference. */
  requestedModel?: string;
  /** Provider priority for free-tier ordering, highest first. */
  providerOrder: string[];
  /** The connector:model that represents DeepSeek's default free hop. */
  deepseekModel: string;
  /** Include paid candidates (after all free). Default behaviour is free-only. */
  paidEnabled: boolean;
  /** When false, a requested PAID model that fails does NOT fall back to free. */
  allowFreeDowngrade: boolean;
}

interface BuiltEntry {
  candidate: CascadeCandidate;
  isDeepseek: boolean;
  providerRank: number;
  declOrder: number;
}

function isDeepseekEntry(connector: string, model: string, deepseekModel: string): boolean {
  return model === deepseekModel || /deepseek/i.test(model);
}

/**
 * Flatten all chat, declared models across connectors into ordered candidates.
 * Returns the full ordered free→paid list (before requested-model promotion).
 */
function collectEntries(input: BuildFailoverCandidatesInput): BuiltEntry[] {
  const { capabilities, providerOrder, deepseekModel } = input;
  const rankOf = (name: string) => {
    const i = providerOrder.indexOf(name);
    return i === -1 ? providerOrder.length : i;
  };

  const entries: BuiltEntry[] = [];
  let decl = 0;
  for (const caps of capabilities) {
    const connectorModality: ModelModality = caps.modality ?? 'chat';
    const freeSet = new Set<string>(caps.freeModels ?? []);
    const metas: ProviderModelMeta[] = caps.modelMeta?.length
      ? caps.modelMeta
      : caps.models.map((id) => ({ id }));

    for (const meta of metas) {
      const model = meta.id;
      const modality: ModelModality = meta.modality ?? connectorModality;
      // Anti-fabrication: only chat models run through the OpenAI chat-completions path.
      // (chat is the only modality `isModalityExecutableHere` allows for /v1/chat/completions.)
      if (modality !== 'chat') continue;

      const free = meta.free ?? freeSet.has(model);
      entries.push({
        candidate: { connector: caps.name, model, tier: free ? 'free' : 'paid' },
        isDeepseek: free && isDeepseekEntry(caps.name, model, deepseekModel),
        providerRank: rankOf(caps.name),
        declOrder: decl++,
      });
    }
  }
  return entries;
}

function dedupe(candidates: CascadeCandidate[]): CascadeCandidate[] {
  const seen = new Set<string>();
  const out: CascadeCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.connector}:${c.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Order: DeepSeek-free → other free (by providerRank, then declared order) → paid
 * (only when paidEnabled, same ordering). Deterministic & stable for reproducible tests.
 */
function orderFreeFirst(entries: BuiltEntry[], paidEnabled: boolean): CascadeCandidate[] {
  const free = entries.filter((e) => e.candidate.tier === 'free');
  const paid = paidEnabled ? entries.filter((e) => e.candidate.tier === 'paid') : [];

  const byRank = (a: BuiltEntry, b: BuiltEntry) =>
    a.providerRank - b.providerRank || a.declOrder - b.declOrder;

  const freeSorted = [...free].sort((a, b) => {
    // DeepSeek free hops first, then the rest by provider rank.
    if (a.isDeepseek !== b.isDeepseek) return a.isDeepseek ? -1 : 1;
    return byRank(a, b);
  });
  const paidSorted = [...paid].sort(byRank);

  return [...freeSorted, ...paidSorted].map((e) => e.candidate);
}

/**
 * Build the failover candidate list. Requested model (when it resolves to a declared
 * chat model) is promoted to the front; the free-first chain follows as fallback
 * (the Hermes use case: ask for a model, get a live free model on 429). Aliases
 * (auto/failover/free) or an unknown id skip promotion and use the pure free-first chain.
 */
export function buildFailoverCandidates(input: BuildFailoverCandidatesInput): CascadeCandidate[] {
  const entries = collectEntries(input);
  const freeFirst = orderFreeFirst(entries, input.paidEnabled);

  const requested = input.requestedModel?.trim();
  const isAlias = requested === undefined || AUTO_ALIASES.has(requested.toLowerCase());

  if (isAlias) {
    const result = dedupe(freeFirst);
    validateFreeBeforePaid(result);
    return result;
  }

  // Find the requested model among declared chat models (first connector wins).
  const match = entries.find((e) => e.candidate.model === requested);
  if (!match) {
    // Unknown id → treat as "auto": serve from the free-first chain (gateway behaviour).
    const result = dedupe(freeFirst);
    validateFreeBeforePaid(result);
    return result;
  }

  if (match.candidate.tier === 'paid' && !input.allowFreeDowngrade) {
    // Strict: a requested paid model must not silently downgrade to free.
    return [match.candidate];
  }

  // Promote requested model to the front, then append the free-first chain (deduped).
  // Note: when the requested model is paid + downgrade allowed, the leading paid entry
  // precedes free ones by design, so the free-before-paid invariant is intentionally
  // not enforced for this explicit-paid-preference path.
  return dedupe([match.candidate, ...freeFirst]);
}
