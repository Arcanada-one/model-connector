// AUP-CACHE-006 — admin surface: state, mode switch with receipt, events.

import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PromptCacheAdminController } from './prompt-cache-admin.controller';
import { PromptCachePolicyService } from './prompt-cache-policy.service';

function build() {
  const service = new PromptCachePolicyService({
    mode: 'observe',
    sink: { emit: () => undefined },
  });
  return { service, controller: new PromptCacheAdminController(service) };
}

describe('PromptCacheAdminController (AUP-CACHE-006)', () => {
  it('reports the state', () => {
    const { controller } = build();
    const state = controller.getPolicy();
    expect(state.mode).toBe('observe');
    expect(state.contract.id).toBe('prompt-layout.v1');
    expect(state.contract.models).toContain('claude-fable-5-1');
  });

  it('refuses a switch without actor/reason or with an unknown mode (400)', () => {
    const { controller, service } = build();
    for (const body of [
      { mode: 'enforce' },
      { mode: 'enforce', actor: 'x', reason: 'short' },
      { mode: 'strict', actor: 'x', reason: 'a long enough reason' },
      { mode: 'enforce', actor: 'x', reason: 'a long enough reason', extra: 1 },
    ]) {
      expect(() => controller.setMode(body)).toThrow(HttpException);
    }
    expect(service.getMode()).toBe('observe');
  });

  it('switches with a receipt', () => {
    const { controller, service } = build();
    const receipt = controller.setMode({
      mode: 'enforce',
      actor: 'owner',
      reason: 'matrix is green, enabling',
    });
    expect(receipt.to).toBe('enforce');
    expect(service.getMode()).toBe('enforce');
  });

  it('lists events with a validated limit', () => {
    const { controller } = build();
    expect(controller.getEvents().count).toBeGreaterThan(0);
    expect(controller.getEvents('1').events).toHaveLength(1);
    expect(() => controller.getEvents('0')).toThrow(HttpException);
    expect(() => controller.getEvents('x')).toThrow(HttpException);
  });
});
