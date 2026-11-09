/**
 * Controller-level integrity refusal mapping.
 *
 * MV-CONTROLLER-REFUSAL-200 / MV-CONTROLLER-DISCLOSE: the prepare path must
 * return HTTP 409 with the typed reason and must not disclose response bytes.
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { ProtectedLabController } from './protected-lab.controller';
import { ConnectorsService } from './connectors.service';
import { INTEGRITY_REFUSAL_REASON } from '../billing/protected-result-integrity';

interface AuthenticatedRequestStub extends FastifyRequest {
  apiKey?: { id: string };
}

const authenticatedRequest = (apiKeyId: string): AuthenticatedRequestStub =>
  ({ apiKey: { id: apiKeyId } }) as AuthenticatedRequestStub;

describe('ProtectedLabController integrity_refused', () => {
  let controller: ProtectedLabController;
  let prepareProtectedReservation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    prepareProtectedReservation = vi.fn();
    const connectors = {
      isProtectedLabProfileEnabled: vi.fn().mockReturnValue(true),
      protectedLabConnectors: vi.fn().mockReturnValue(new Set(['mock'])),
      connectorSupportsProtectedDispatchFence: vi.fn().mockReturnValue(true),
      prepareProtectedReservation,
    } as unknown as ConnectorsService;
    controller = new ProtectedLabController(connectors);
  });

  const prepareBody = {
    model: 'm',
    prompt: 'integrity refusal probe',
  };

  it.each([
    INTEGRITY_REFUSAL_REASON.integrity_digest_mismatch,
    INTEGRITY_REFUSAL_REASON.integrity_unverified,
  ] as const)(
    'returns HTTP 409 with typed %s and no response bytes',
    async (reason) => {
      prepareProtectedReservation.mockResolvedValue({
        outcome: 'integrity_refused',
        reason,
      });

      let caught: unknown;
      try {
        await controller.prepare(
          'mock',
          prepareBody,
          'idem-integrity-refuse',
          authenticatedRequest('key-a'),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(HttpException);
      const ex = caught as HttpException;
      expect(ex.getStatus()).toBe(HttpStatus.CONFLICT);
      const body = ex.getResponse() as Record<string, unknown>;
      expect(body).toEqual({
        error: reason,
        message:
          'Protected settled result failed retained integrity verification; no disclosure.',
      });
      expect(body).not.toHaveProperty('response');
      expect(body).not.toHaveProperty('replay');
      expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    },
  );
});
