import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { DecisionsController } from './decisions.controller';
import { DecisionsRouteService } from './decisions.service';
import { publicDecisionRequestSchema } from './dto/decision-request.dto';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

function makeReply(): { reply: FastifyReply; sent: Record<string, unknown> } {
  const sent: Record<string, unknown> = { headers: {}, body: null, status: null };
  const replyBase: { statusCode?: number } = {};
  const reply = Object.assign(replyBase, {
    header: vi.fn((k: string, v: unknown) => {
      (sent.headers as Record<string, unknown>)[k.toLowerCase()] = v;
      return reply;
    }),
    status: vi.fn((s: number) => {
      sent.status = s;
      replyBase.statusCode = s;
      return reply;
    }),
    send: vi.fn((b: unknown) => {
      sent.body = b;
      return reply;
    }),
  }) as unknown as FastifyReply;
  return { reply, sent };
}

describe('DecisionsController POST /v1/decisions', () => {
  let controller: DecisionsController;
  let service: { handle: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    service = { handle: vi.fn() };
    controller = new DecisionsController(service as unknown as DecisionsRouteService);
  });

  it('returns 201 decision for a known template body', async () => {
    const body = publicDecisionRequestSchema.parse({
      template: 'task.intent',
      state: { trusted: { task_text: 'Add decisions route' } },
    });
    service.handle.mockResolvedValue({
      schema: 'DecisionResult/v1',
      decision_id: 'd1',
      template_ref: { id: 'task.intent', version: 1 },
      state_digest: 'abc',
      decision: { version: 'DecisionResult/v1', status: 'observed', action: 'none' },
    });
    const { reply, sent } = makeReply();
    await controller.create(body, undefined, { apiKey: { id: 'key-1' } } as never, reply);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      schema: 'DecisionResult/v1',
      template_ref: { id: 'task.intent' },
    });
    expect(service.handle).toHaveBeenCalledTimes(1);
  });

  it('Zod pipe rejects missing template before service', () => {
    const pipe = new ZodValidationPipe(publicDecisionRequestSchema);
    expect(() => pipe.transform({ state: { trusted: { task_text: 'x' } } })).toThrow(
      BadRequestException,
    );
  });
});
