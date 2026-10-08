import { ProfileSpendError } from './plan';
import { spendPageSchema, type SpendEvent } from './envelope';

export interface MirrorAuthority {
  ledgerId: string;
  accountId: string;
  ownerProfileId: string;
}
export interface EnvelopeHold {
  physicalId: string;
  runId: string;
  admittedAt: string;
  route: 'direct' | 'mc';
  state: 'reserved' | 'claimed' | 'dispatch_started' | 'completed' | 'uncertain' | 'settled';
  heldNano: string;
  observedNano: string | null;
  reconciliation: 'NOT_MEASURED' | 'PROVEN';
}

/** Reference adapter: caller must persist its state atomically before dispatch.
 * The authority and attempt mapping come from the authenticated registry, never
 * from a supplied page. This does not replace Prime's global budget authority. */
export class PrimeExposureEnvelope {
  private cursor = 0n;
  private paused = true;
  private observedAt = 0;
  private readonly events = new Map<string, string>();
  private readonly mc = new Map<string, EnvelopeHold>();
  constructor(
    private readonly authority: MirrorAuthority,
    direct: readonly EnvelopeHold[],
    private readonly physicalMapping: Readonly<Record<string, string>>,
  ) {
    this.authority = Object.freeze({ ...authority });
    if (
      direct.some(
        (h) =>
          !/^(0|[1-9][0-9]{0,29})$/.test(h.heldNano) ||
          !Number.isFinite(Date.parse(h.admittedAt)) ||
          !['direct', 'mc'].includes(h.route) ||
          ![
            'reserved',
            'claimed',
            'dispatch_started',
            'completed',
            'uncertain',
            'settled',
          ].includes(h.state) ||
          (h.route === 'mc' && h.state === 'settled'),
      )
    )
      throw new ProfileSpendError('prime_envelope_baseline_invalid');
    this.direct = direct.map((h) => Object.freeze({ ...h }));
    const physical = Object.values(physicalMapping);
    if (new Set(physical).size !== physical.length)
      throw new ProfileSpendError('prime_envelope_mapping_conflict');
    this.physicalMapping = Object.freeze({ ...physicalMapping });
  }
  private readonly direct: readonly EnvelopeHold[];

  import(raw: unknown, now = new Date()): void {
    try {
      const page = spendPageSchema.parse(raw);
      const observedAt = Date.parse(page.observedAt);
      if (
        now.getTime() - observedAt > 60_000 ||
        observedAt > now.getTime() + 5_000 ||
        page.ledgerId !== this.authority.ledgerId ||
        page.accountId !== this.authority.accountId ||
        page.ownerProfileId !== this.authority.ownerProfileId ||
        BigInt(page.after) > this.cursor ||
        BigInt(page.watermark) < this.cursor ||
        BigInt(page.through) > BigInt(page.watermark)
      )
        throw new Error('authority_or_cursor');
      const nextEvents = new Map(this.events),
        nextHolds = new Map(this.mc);
      let nextCursor = this.cursor;
      let pageCursor = BigInt(page.after);
      for (const event of page.events) {
        const n = BigInt(event.sequence),
          serialized = JSON.stringify(event);
        if (n !== pageCursor + 1n) throw new Error('page_gap');
        pageCursor = n;
        if (n <= nextCursor) {
          if (nextEvents.get(event.sequence) !== serialized) throw new Error('conflicting_replay');
          continue;
        }
        if (n !== nextCursor + 1n) throw new Error('event_gap');
        const attempt = event.attempt;
        if (
          attempt.accountId !== this.authority.accountId ||
          attempt.ownerProfileId !== this.authority.ownerProfileId
        )
          throw new Error('foreign_attempt');
        const physicalId = this.physicalMapping[attempt.id];
        if (!physicalId) throw new Error('mapping_missing');
        const previous = nextHolds.get(attempt.id);
        if (
          previous &&
          (previous.physicalId !== physicalId ||
            previous.runId !== attempt.runId ||
            previous.admittedAt !== attempt.admittedAt ||
            BigInt(attempt.heldNano) < BigInt(previous.heldNano))
        )
          throw new Error('hold_reduced_without_release');
        nextHolds.set(attempt.id, this.hold(event, physicalId));
        nextEvents.set(event.sequence, serialized);
        nextCursor = n;
      }
      if (BigInt(page.through) !== nextCursor) throw new Error('incomplete_page');
      this.events.clear();
      for (const entry of nextEvents) this.events.set(...entry);
      this.mc.clear();
      for (const entry of nextHolds) this.mc.set(...entry);
      this.cursor = nextCursor;
      this.observedAt = observedAt;
      this.paused = nextCursor !== BigInt(page.watermark);
    } catch {
      this.paused = true;
      throw new ProfileSpendError('prime_envelope_import_unavailable');
    }
  }

  exposure(from: Date, to: Date, runId?: string): bigint {
    const unique = new Map<string, EnvelopeHold & { carry: boolean }>();
    for (const hold of [...this.direct, ...this.mc.values()]) {
      const previous = unique.get(hold.physicalId);
      if (previous && (previous.runId !== hold.runId || previous.admittedAt !== hold.admittedAt))
        throw new ProfileSpendError('prime_envelope_identity_conflict');
      const chosen =
        !previous || BigInt(hold.heldNano) > BigInt(previous.heldNano) ? hold : previous;
      const carry =
        hold.route === 'mc' ? hold.reconciliation === 'NOT_MEASURED' : hold.state !== 'settled';
      unique.set(hold.physicalId, {
        ...chosen,
        carry: carry || previous?.carry === true,
        reconciliation:
          hold.reconciliation === 'NOT_MEASURED' || previous?.reconciliation === 'NOT_MEASURED'
            ? 'NOT_MEASURED'
            : 'PROVEN',
      });
    }
    let sum = 0n;
    for (const hold of unique.values()) {
      const at = Date.parse(hold.admittedAt);
      if (
        (!runId || hold.runId === runId) &&
        ((at >= from.getTime() && at < to.getTime()) || (at < from.getTime() && hold.carry))
      )
        sum += BigInt(hold.heldNano);
    }
    return sum;
  }
  admit(reserveNano: bigint, limitNano: bigint, from: Date, to: Date, runId?: string): void {
    if (this.paused || Date.now() - this.observedAt > 60_000)
      throw new ProfileSpendError('prime_envelope_paused');
    if (
      reserveNano < 0n ||
      limitNano < 0n ||
      this.exposure(from, to, runId) + reserveNano > limitNano
    )
      throw new ProfileSpendError('prime_envelope_cap_exceeded', 429);
  }
  private hold(event: SpendEvent, physicalId: string): EnvelopeHold {
    const a = event.attempt;
    return {
      physicalId,
      runId: a.runId,
      admittedAt: a.admittedAt,
      route: 'mc',
      state: a.state,
      heldNano: a.heldNano,
      observedNano: a.observedNano,
      reconciliation: a.reconciliation,
    };
  }
}
