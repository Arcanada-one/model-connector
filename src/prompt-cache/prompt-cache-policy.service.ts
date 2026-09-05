// AUP-CACHE-006 (enforce0) — the gateway's prompt-cache policy: mode, state,
// typed events, mode-switch receipts.
//
// MODES. `off` = the evaluator never runs (kill switch). `observe` (default)
// = every cache-claiming request is evaluated and its decision attached to the
// response and emitted as an event; NOTHING is refused, so switching it on
// changes what is seen and not what is served. `enforce` = a VIOLATION is
// refused with a typed `policy_violation` error carrying the decision. The
// boot mode comes from PROMPT_CACHE_POLICY_MODE; the owner switches at runtime
// through POST /admin/prompt-cache/policy/mode, which returns a
// PolicyModeSwitchReceipt/v1 and is reversible by the same call. The runtime
// switch lives in process memory: a restart returns to the env default and the
// receipt says so (`persistence`).
//
// EVENTS. Every decision on a cache-claiming request, every mode switch and the
// contract load emit a PromptCachePolicyEvent/v1 (see
// docs/reference/prompt-cache-policy.md for the Ops Bot design). The default
// sink is the structured logger; a transport to Ops Bot is a later sink, not a
// change of shape. Events carry codes, layers and hashes — never request text.
//
// The gateway never "fixes" a request: there is no rewrite path anywhere in
// this module.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ActiveMode,
  InMemoryPolicyStore,
  POLICY_MODES,
  PolicyContext,
  PolicyMode,
  PromptCachePolicyDecision,
  evaluatePromptCachePolicy,
} from './prompt-cache-policy';
import { PromptLayoutContract, loadVendoredPromptLayoutContract } from './prompt-layout-contract';

export const PROMPT_CACHE_POLICY_MODE_ENV = 'PROMPT_CACHE_POLICY_MODE';
export const GATEWAY_NAME = 'model-connector';

export interface PromptCachePolicyEvent {
  readonly schema: 'PromptCachePolicyEvent/v1';
  readonly event: 'decision' | 'mode_switched' | 'contract_loaded';
  readonly ts: string;
  readonly gateway: string;
  readonly mode: PolicyMode;
  readonly contract_digest: string;
  readonly decision?: {
    readonly decision_id: string;
    readonly tenant: string;
    readonly session_id: string | null;
    readonly session_epoch: string | null;
    readonly model: string | null;
    readonly verdict: PromptCachePolicyDecision['verdict'];
    readonly action: PromptCachePolicyDecision['action'];
    readonly codes: readonly { code: string; severity: string; layer: string }[];
    readonly prefix_hash: string | null;
    readonly cache_identity: string | null;
    readonly prefix_changed: boolean;
    readonly prewarm: boolean;
    readonly evaluated_ms: number;
  };
  readonly receipt?: PolicyModeSwitchReceipt;
}

export interface PolicyModeSwitchReceipt {
  readonly schema: 'PolicyModeSwitchReceipt/v1';
  readonly receipt_id: string;
  readonly ts: string;
  readonly gateway: string;
  readonly from: PolicyMode;
  readonly to: PolicyMode;
  readonly changed: boolean;
  readonly actor: string;
  readonly reason: string;
  readonly contract_digest: string;
  readonly reversible: true;
  readonly revert: { readonly mode: PolicyMode };
  readonly persistence: string;
}

export interface PolicyEventSink {
  emit(event: PromptCachePolicyEvent): void;
}

export class PromptCachePolicyConfigError extends Error {
  constructor(reason: string) {
    super(`prompt-cache policy configuration is invalid: ${reason}`);
    this.name = 'PromptCachePolicyConfigError';
  }
}

export function parsePolicyMode(value: unknown): PolicyMode {
  if (value === undefined || value === '') return 'observe';
  if (typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value)) {
    return value as PolicyMode;
  }
  throw new PromptCachePolicyConfigError(
    `${PROMPT_CACHE_POLICY_MODE_ENV}=${JSON.stringify(value)} is not one of ${POLICY_MODES.join('/')}`,
  );
}

/** DI token for construction options (tests / future module config); absent under Nest → defaults. */
export const PROMPT_CACHE_POLICY_OPTIONS = Symbol('PROMPT_CACHE_POLICY_OPTIONS');

export interface PromptCachePolicyServiceOptions {
  readonly mode?: PolicyMode;
  readonly contract?: PromptLayoutContract;
  readonly sink?: PolicyEventSink;
  readonly store?: InMemoryPolicyStore;
}

const EVENT_RING = 500;
const RECEIPT_RING = 100;
const PERSISTENCE_NOTE =
  'process memory; a restart returns to the PROMPT_CACHE_POLICY_MODE boot default';

@Injectable()
export class PromptCachePolicyService {
  private readonly logger = new Logger(PromptCachePolicyService.name);
  readonly contract: PromptLayoutContract;
  readonly bootMode: PolicyMode;
  private mode: PolicyMode;
  private readonly store: InMemoryPolicyStore;
  private readonly sink: PolicyEventSink;
  private readonly events: PromptCachePolicyEvent[] = [];
  private readonly receipts: PolicyModeSwitchReceipt[] = [];

  constructor(
    @Optional()
    @Inject(PROMPT_CACHE_POLICY_OPTIONS)
    options: PromptCachePolicyServiceOptions = {},
  ) {
    // A malformed vendored contract throws here → the module fails to
    // construct → the gateway does not boot (fail closed, MUN-0041 pattern).
    this.contract = options.contract ?? loadVendoredPromptLayoutContract();
    this.bootMode = options.mode ?? parsePolicyMode(process.env[PROMPT_CACHE_POLICY_MODE_ENV]);
    this.mode = this.bootMode;
    this.store = options.store ?? new InMemoryPolicyStore();
    this.sink = options.sink ?? {
      emit: (event) => {
        const line = JSON.stringify(event);
        if (event.decision && event.decision.action !== 'pass') this.logger.warn(line);
        else this.logger.log(line);
      },
    };
    this.emit({
      schema: 'PromptCachePolicyEvent/v1',
      event: 'contract_loaded',
      ts: new Date().toISOString(),
      gateway: GATEWAY_NAME,
      mode: this.mode,
      contract_digest: this.contract.digest,
    });
  }

  getMode(): PolicyMode {
    return this.mode;
  }

  isActive(): boolean {
    return this.mode !== 'off';
  }

  /**
   * Evaluate a Messages API body in the current mode. Returns null when the
   * policy is off. Emits a decision event for every cache-claiming request.
   */
  evaluate(body: unknown, ctx: PolicyContext): PromptCachePolicyDecision | null {
    if (this.mode === 'off') return null;
    const decision = evaluatePromptCachePolicy(body, ctx, {
      contract: this.contract,
      mode: this.mode as ActiveMode,
      store: this.store,
      decisionId: randomUUID(),
    });
    if (decision.caching_claimed || decision.verdict === 'UNDETERMINED') {
      this.emit({
        schema: 'PromptCachePolicyEvent/v1',
        event: 'decision',
        ts: new Date().toISOString(),
        gateway: GATEWAY_NAME,
        mode: this.mode,
        contract_digest: this.contract.digest,
        decision: {
          decision_id: decision.decision_id,
          tenant: decision.tenant,
          session_id: decision.session.id,
          session_epoch: decision.session.epoch,
          model: decision.model,
          verdict: decision.verdict,
          action: decision.action,
          codes: decision.findings.map((f) => ({
            code: f.code,
            severity: f.severity,
            layer: f.layer,
          })),
          prefix_hash: decision.prefix_hash,
          cache_identity: decision.cache_identity,
          prefix_changed: decision.session.prefix_changed,
          prewarm: decision.prewarm,
          evaluated_ms: decision.evaluated_ms,
        },
      });
    }
    return decision;
  }

  /** Switch the mode at runtime; returns the receipt. Reversible by calling again with `revert.mode`. */
  setMode(next: PolicyMode, by: { actor: string; reason: string }): PolicyModeSwitchReceipt {
    if (!(POLICY_MODES as readonly string[]).includes(next)) {
      throw new PromptCachePolicyConfigError(
        `mode ${JSON.stringify(next)} is not one of ${POLICY_MODES.join('/')}`,
      );
    }
    const from = this.mode;
    this.mode = next;
    const receipt: PolicyModeSwitchReceipt = {
      schema: 'PolicyModeSwitchReceipt/v1',
      receipt_id: randomUUID(),
      ts: new Date().toISOString(),
      gateway: GATEWAY_NAME,
      from,
      to: next,
      changed: from !== next,
      actor: by.actor,
      reason: by.reason,
      contract_digest: this.contract.digest,
      reversible: true,
      revert: { mode: from },
      persistence: PERSISTENCE_NOTE,
    };
    this.receipts.push(receipt);
    if (this.receipts.length > RECEIPT_RING) this.receipts.shift();
    this.emit({
      schema: 'PromptCachePolicyEvent/v1',
      event: 'mode_switched',
      ts: receipt.ts,
      gateway: GATEWAY_NAME,
      mode: next,
      contract_digest: this.contract.digest,
      receipt,
    });
    return receipt;
  }

  getState(): {
    mode: PolicyMode;
    boot_mode: PolicyMode;
    contract: { id: string; digest: string; models: string[] };
    store: { sessions: number; prefixes: number; sessionIds: number };
    receipts: readonly PolicyModeSwitchReceipt[];
  } {
    return {
      mode: this.mode,
      boot_mode: this.bootMode,
      contract: {
        id: this.contract.id,
        digest: this.contract.digest,
        models: Object.keys(this.contract.models),
      },
      store: this.store.size,
      receipts: [...this.receipts],
    };
  }

  recentEvents(limit = 100): readonly PromptCachePolicyEvent[] {
    const n = Math.max(0, Math.min(limit, EVENT_RING));
    return this.events.slice(-n);
  }

  private emit(event: PromptCachePolicyEvent): void {
    this.events.push(event);
    if (this.events.length > EVENT_RING) this.events.shift();
    try {
      this.sink.emit(event);
    } catch (err) {
      // An event sink must never take the request path down with it.
      this.logger.error(`prompt-cache policy event sink failed: ${(err as Error).message}`);
    }
  }
}
