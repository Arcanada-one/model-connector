// AUP-CACHE-006 — PromptCachePolicyService: boot mode, off/observe/enforce,
// mode-switch receipts (reversible), typed events, sink isolation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PromptCachePolicyConfigError,
  PromptCachePolicyEvent,
  PromptCachePolicyService,
  parsePolicyMode,
} from './prompt-cache-policy.service';
import { buildReplayRequest, loadReplayFixture } from '../../test/prompt-cache/replay-fixture';

const fixture = loadReplayFixture();

function capture() {
  const events: PromptCachePolicyEvent[] = [];
  return { events, sink: { emit: (e: PromptCachePolicyEvent) => events.push(e) } };
}

describe('PromptCachePolicyService (AUP-CACHE-006)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PROMPT_CACHE_POLICY_MODE;
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('parses the boot mode: unset → observe; bogus → refused', () => {
    expect(parsePolicyMode(undefined)).toBe('observe');
    expect(parsePolicyMode('')).toBe('observe');
    expect(parsePolicyMode('enforce')).toBe('enforce');
    expect(() => parsePolicyMode('strict')).toThrow(PromptCachePolicyConfigError);
    process.env.PROMPT_CACHE_POLICY_MODE = 'off';
    const { sink } = capture();
    expect(new PromptCachePolicyService({ sink }).getMode()).toBe('off');
  });

  it('emits contract_loaded at construction with the pinned digest', () => {
    const { events, sink } = capture();
    const service = new PromptCachePolicyService({ mode: 'observe', sink });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('contract_loaded');
    expect(events[0].contract_digest).toBe(service.contract.digest);
    expect(events[0].contract_digest).toMatch(/^sha256:678dfa2e/);
  });

  it('off: evaluate returns null and emits nothing', () => {
    const { events, sink } = capture();
    const service = new PromptCachePolicyService({ mode: 'off', sink });
    expect(service.isActive()).toBe(false);
    expect(service.evaluate(buildReplayRequest(fixture, 1), { tenantId: 'k' })).toBeNull();
    expect(events.filter((e) => e.event === 'decision')).toHaveLength(0);
  });

  it('observe: a violation is marked, emitted as a typed event, and let through', () => {
    const { events, sink } = capture();
    const service = new PromptCachePolicyService({ mode: 'observe', sink });
    const request = buildReplayRequest(fixture, 1);
    request.model = 'claude-sonnet-5';
    request.system = 'a string cannot carry breakpoints';
    (request.tools as Record<string, unknown>[])[0].cache_control = { type: 'ephemeral' };
    const decision = service.evaluate(request, { tenantId: 'k', sessionId: 's' });
    expect(decision?.verdict).toBe('VIOLATION');
    expect(decision?.action).toBe('mark');
    const event = events.find((e) => e.event === 'decision');
    expect(event?.schema).toBe('PromptCachePolicyEvent/v1');
    expect(event?.decision?.tenant).toBe('k');
    expect(event?.decision?.session_id).toBe('s');
    expect(event?.decision?.codes.map((c) => c.code)).toContain('SYSTEM_NOT_BLOCKS');
    expect(JSON.stringify(event)).not.toContain('a string cannot carry');
  });

  it('enforce: the same violation is refused; a conforming step passes', () => {
    const { sink } = capture();
    const service = new PromptCachePolicyService({ mode: 'enforce', sink });
    const bad = buildReplayRequest(fixture, 1);
    bad.system = 'string';
    expect(service.evaluate(bad, { tenantId: 'k' })?.action).toBe('refuse');
    expect(service.evaluate(buildReplayRequest(fixture, 1), { tenantId: 'k' })?.action).toBe(
      'pass',
    );
  });

  it('switches observe → enforce with a receipt and back with the receipt’s revert', () => {
    const { events, sink } = capture();
    const service = new PromptCachePolicyService({ mode: 'observe', sink });
    const receipt = service.setMode('enforce', {
      actor: 'conn-owner',
      reason: 'fixture matrix green; enabling',
    });
    expect(receipt.schema).toBe('PolicyModeSwitchReceipt/v1');
    expect(receipt.from).toBe('observe');
    expect(receipt.to).toBe('enforce');
    expect(receipt.changed).toBe(true);
    expect(receipt.reversible).toBe(true);
    expect(receipt.revert).toEqual({ mode: 'observe' });
    expect(receipt.persistence).toMatch(/process memory/);
    expect(service.getMode()).toBe('enforce');
    const back = service.setMode(receipt.revert.mode, {
      actor: 'conn-owner',
      reason: 'rolling back the switch',
    });
    expect(back.from).toBe('enforce');
    expect(back.to).toBe('observe');
    expect(service.getMode()).toBe('observe');
    expect(events.filter((e) => e.event === 'mode_switched')).toHaveLength(2);
    expect(service.getState().receipts.map((r) => r.to)).toEqual(['enforce', 'observe']);
    expect(service.getState().boot_mode).toBe('observe');
    expect(() =>
      service.setMode('strict' as never, { actor: 'x', reason: 'not a mode at all' }),
    ).toThrow(PromptCachePolicyConfigError);
  });

  it('a failing sink is logged, never thrown into the request path', () => {
    const service = new PromptCachePolicyService({
      mode: 'observe',
      sink: {
        emit: () => {
          throw new Error('ops bot down');
        },
      },
    });
    expect(() => service.evaluate(buildReplayRequest(fixture, 1), { tenantId: 'k' })).not.toThrow();
    expect(service.recentEvents(10).length).toBeGreaterThan(0);
  });

  it('keeps a bounded ring of recent events', () => {
    const { sink } = capture();
    const service = new PromptCachePolicyService({ mode: 'observe', sink });
    for (let i = 0; i < 520; i += 1) {
      service.evaluate(buildReplayRequest(fixture, 1), { tenantId: 'k' });
    }
    expect(service.recentEvents(1000)).toHaveLength(500);
    expect(service.recentEvents(3)).toHaveLength(3);
  });
});
