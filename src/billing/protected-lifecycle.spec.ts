/**
 * Round 15 — immutable phase membership + P10-05 replay classification.
 *
 * Production resolve/settle paths must not consult exported mutable Sets/arrays.
 * Classification asserts refusals without requiring Auth read entitlement.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PROTECTED_LIFECYCLE_VERSION,
  PROTECTED_PHASE,
  classifyProtectedIntentReplay,
  isProtectedNonExpirePhase,
  protectedNonExpirePhases,
  protectedSettleablePhases,
  retainedProtectedResultHash,
  type ProtectedIntentReplayRow,
  type ProtectedPhase,
} from './protected-lifecycle';

function baseRow(
  overrides: Partial<ProtectedIntentReplayRow> &
    Pick<ProtectedIntentReplayRow, 'protectedPhase' | 'state'>,
): ProtectedIntentReplayRow {
  return {
    lifecycleVersion: PROTECTED_LIFECYCLE_VERSION,
    payloadFingerprint: 'fp-a',
    operationKey: 'op-a',
    intentKey: 'op-a',
    response: undefined,
    requestId: null,
    completedAt: null,
    holdUsd: '1.000000',
    reservationRef: 'res-1',
    generation: 1,
    ...overrides,
  };
}

describe('immutable protected phase membership', () => {
  it('isProtectedNonExpirePhase covers dispatch_committed, unknown, settled only', () => {
    expect(isProtectedNonExpirePhase(PROTECTED_PHASE.dispatch_committed)).toBe(true);
    expect(isProtectedNonExpirePhase(PROTECTED_PHASE.unknown)).toBe(true);
    expect(isProtectedNonExpirePhase(PROTECTED_PHASE.settled)).toBe(true);
    expect(isProtectedNonExpirePhase(PROTECTED_PHASE.reserved)).toBe(false);
    expect(isProtectedNonExpirePhase(PROTECTED_PHASE.proven_no_dispatch)).toBe(false);
    expect(isProtectedNonExpirePhase(null)).toBe(false);
  });

  it('protectedSettleablePhases returns a fresh frozen copy without reserved', () => {
    const a = protectedSettleablePhases();
    const b = protectedSettleablePhases();
    expect(a).toEqual([
      PROTECTED_PHASE.dispatch_committed,
      PROTECTED_PHASE.unknown,
    ]);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.includes(PROTECTED_PHASE.reserved)).toBe(false);
  });

  it('M-PHASE-NONEXPIRE-LIVE / negative: mutating exported non-expire view throws or is inert', async () => {
    const view = protectedNonExpirePhases() as string[];
    expect(Object.isFrozen(view)).toBe(true);
    expect(view).toContain(PROTECTED_PHASE.unknown);
    expect(() => {
      view.splice(view.indexOf(PROTECTED_PHASE.unknown), 1);
    }).toThrow();
    // If a live Set were re-exported and consulted by the predicate, deleting
    // unknown would flip this false — that is the M-PHASE-NONEXPIRE-LIVE kill.
    const mod = await import('./protected-lifecycle');
    const live = (mod as { PROTECTED_NON_EXPIRE_PHASES?: Set<string> })
      .PROTECTED_NON_EXPIRE_PHASES;
    if (live instanceof Set) {
      live.delete(PROTECTED_PHASE.unknown);
    }
    expect(isProtectedNonExpirePhase(PROTECTED_PHASE.unknown)).toBe(true);
    expect(protectedNonExpirePhases()).toContain(PROTECTED_PHASE.unknown);
  });

  it('M-PHASE-SETTLE-LIVE / negative: mutating exported settleable view throws or is inert', async () => {
    const view = protectedSettleablePhases() as string[];
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      view.push(PROTECTED_PHASE.reserved);
    }).toThrow();
    const mod = await import('./protected-lifecycle');
    const live = (mod as { PROTECTED_SETTLEABLE_PHASES?: ProtectedPhase[] })
      .PROTECTED_SETTLEABLE_PHASES;
    if (Array.isArray(live) && !Object.isFrozen(live)) {
      live.push(PROTECTED_PHASE.reserved);
    }
    expect(protectedSettleablePhases().includes(PROTECTED_PHASE.reserved)).toBe(false);
  });

  it('M-PHASE-RESERVED-SETTLEABLE: reserved is never in the settleable list', () => {
    expect(protectedSettleablePhases()).not.toContain(PROTECTED_PHASE.reserved);
  });

  it('billing.service production path uses phase predicates, not live exported collections', () => {
    const billingSrc = readFileSync(
      path.join(__dirname, 'billing.service.ts'),
      'utf8',
    );
    expect(billingSrc).toMatch(/isProtectedNonExpirePhase\(/);
    expect(billingSrc).toMatch(/protectedSettleablePhases\(\)/);
    expect(billingSrc).not.toMatch(/PROTECTED_NON_EXPIRE_PHASES\.has/);
    expect(billingSrc).not.toMatch(/\[\.\.\.PROTECTED_SETTLEABLE_PHASES\]/);
  });
});

describe('P10-05 protected replay classification', () => {
  it('reserved is nonterminal in_flight, never replay-eligible', () => {
    const c = classifyProtectedIntentReplay({
      row: baseRow({ protectedPhase: PROTECTED_PHASE.reserved, state: 'held' }),
      payloadFingerprint: 'fp-a',
      operationKey: 'op-a',
    });
    expect(c.kind).toBe('nonterminal');
    if (c.kind === 'nonterminal') {
      expect(c.phase).toBe(PROTECTED_PHASE.reserved);
      expect(c.openOutcome).toBe('in_flight');
    }
    expect(c.replayEligible).toBe(false);
  });

  it('M-P1005-NONTERMINAL: dispatch_committed and unknown refuse completed-result replay', () => {
    for (const phase of [
      PROTECTED_PHASE.dispatch_committed,
      PROTECTED_PHASE.unknown,
    ] as const) {
      const c = classifyProtectedIntentReplay({
        row: baseRow({ protectedPhase: phase, state: 'held' }),
        payloadFingerprint: 'fp-a',
        operationKey: 'op-a',
      });
      expect(c.kind).toBe('nonterminal');
      expect(c.replayEligible).toBe(false);
      if (c.kind === 'nonterminal') {
        expect(c.openOutcome).toBe('protected_unknown');
        expect(c.phase).toBe(phase);
      }
    }
  });

  it('M-P1005-UNKNOWN-AS-INFLIGHT: unknown is typed protected_unknown, not in_flight', () => {
    const unknown = classifyProtectedIntentReplay({
      row: baseRow({ protectedPhase: PROTECTED_PHASE.unknown, state: 'held' }),
      payloadFingerprint: 'fp-a',
    });
    const reserved = classifyProtectedIntentReplay({
      row: baseRow({ protectedPhase: PROTECTED_PHASE.reserved, state: 'held' }),
      payloadFingerprint: 'fp-a',
    });
    expect(unknown.kind).toBe('nonterminal');
    expect(reserved.kind).toBe('nonterminal');
    if (unknown.kind === 'nonterminal' && reserved.kind === 'nonterminal') {
      expect(unknown.openOutcome).toBe('protected_unknown');
      expect(reserved.openOutcome).toBe('in_flight');
      expect(unknown.openOutcome).not.toBe(reserved.openOutcome);
    }
  });

  it('M-P1005-CORRUPT: incomplete / hash-mismatched settled refuses replay', () => {
    const missingResponse = classifyProtectedIntentReplay({
      row: baseRow({
        protectedPhase: PROTECTED_PHASE.settled,
        state: 'completed',
        completedAt: new Date('2026-11-09T00:00:00Z'),
        response: null,
      }),
      payloadFingerprint: 'fp-a',
    });
    expect(missingResponse.kind).toBe('corrupt_settled');
    expect(missingResponse.replayEligible).toBe(false);

    const inconsistentState = classifyProtectedIntentReplay({
      row: baseRow({
        protectedPhase: PROTECTED_PHASE.settled,
        state: 'held',
        response: { ok: true },
        completedAt: new Date('2026-11-09T00:00:00Z'),
      }),
      payloadFingerprint: 'fp-a',
    });
    expect(inconsistentState.kind).toBe('corrupt_settled');

    const body = { answer: 'paid-result' };
    const hash = retainedProtectedResultHash(body);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const mismatched = classifyProtectedIntentReplay({
      row: baseRow({
        protectedPhase: PROTECTED_PHASE.settled,
        state: 'completed',
        response: body,
        completedAt: new Date('2026-11-09T00:00:00Z'),
        requestId: 'req-1',
      }),
      payloadFingerprint: 'fp-a',
      expectedResultHash: '0'.repeat(64),
    });
    expect(mismatched.kind).toBe('corrupt_settled');
    if (mismatched.kind === 'corrupt_settled') {
      expect(mismatched.reason).toBe('retained_result_hash_mismatch');
    }
  });

  it('positive control: complete settled with matching hash is replay-eligible (redacted marker)', () => {
    const body = { answer: 'paid-result' };
    const hash = retainedProtectedResultHash(body)!;
    const c = classifyProtectedIntentReplay({
      row: baseRow({
        protectedPhase: PROTECTED_PHASE.settled,
        state: 'completed',
        response: body,
        completedAt: new Date('2026-11-09T00:00:00Z'),
        requestId: 'req-1',
      }),
      payloadFingerprint: 'fp-a',
      expectedResultHash: hash,
    });
    expect(c.kind).toBe('replay_eligible');
    if (c.kind === 'replay_eligible') {
      expect(c.replayEligible).toBe(true);
      expect(c.resultHash).toBe(hash);
      expect(c.marker).toBe('protected_settled_replay_eligible');
      expect(JSON.stringify(c)).not.toContain('paid-result');
    }
  });

  it('proven_no_dispatch is reclaimable, never a replayable paid result', () => {
    const c = classifyProtectedIntentReplay({
      row: baseRow({
        protectedPhase: PROTECTED_PHASE.proven_no_dispatch,
        state: 'released',
      }),
      payloadFingerprint: 'fp-a',
    });
    expect(c.kind).toBe('proven_no_dispatch');
    expect(c.replayEligible).toBe(false);
    if (c.kind === 'proven_no_dispatch') {
      expect(c.openOutcome).toBe('reclaimable');
    }
  });

  it('mismatched operation or fingerprint binding refuses', () => {
    const fp = classifyProtectedIntentReplay({
      row: baseRow({ protectedPhase: PROTECTED_PHASE.settled, state: 'completed' }),
      payloadFingerprint: 'fp-other',
    });
    expect(fp.kind).toBe('binding_mismatch');

    const op = classifyProtectedIntentReplay({
      row: baseRow({
        protectedPhase: PROTECTED_PHASE.reserved,
        state: 'held',
        operationKey: 'op-a',
        intentKey: 'op-a',
      }),
      payloadFingerprint: 'fp-a',
      operationKey: 'op-b',
    });
    expect(op.kind).toBe('binding_mismatch');
  });
});
