import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreakerAdminController } from './circuit-breaker.controller';
import { ConnectorsService } from '../connectors/connectors.service';

const mockConnectorsService = {
  resetCircuitBreaker: vi.fn(),
};

describe('CircuitBreakerAdminController', () => {
  let controller: CircuitBreakerAdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new CircuitBreakerAdminController(
      mockConnectorsService as unknown as ConnectorsService,
    );
  });

  describe('POST /admin/circuit-breaker/reset', () => {
    it('should reset all connectors when body is empty', () => {
      mockConnectorsService.resetCircuitBreaker.mockReturnValue([
        { connector: 'openrouter', model: 'ling-2.6-flash:free', previousState: 'open' },
      ]);

      const result = controller.reset({});

      expect(mockConnectorsService.resetCircuitBreaker).toHaveBeenCalledWith(undefined, undefined);
      expect(result).toEqual({
        reset: [{ connector: 'openrouter', model: 'ling-2.6-flash:free', previousState: 'open' }],
        count: 1,
      });
    });

    it('should reset specific connector and model', () => {
      mockConnectorsService.resetCircuitBreaker.mockReturnValue([
        { connector: 'openrouter', model: 'gpt-oss-20b:free', previousState: 'half_open' },
      ]);

      const result = controller.reset({
        connector: 'openrouter',
        model: 'gpt-oss-20b:free',
      });

      expect(mockConnectorsService.resetCircuitBreaker).toHaveBeenCalledWith(
        'openrouter',
        'gpt-oss-20b:free',
      );
      expect(result).toEqual({
        reset: [{ connector: 'openrouter', model: 'gpt-oss-20b:free', previousState: 'half_open' }],
        count: 1,
      });
    });

    it('should return empty array when no circuit breakers to reset', () => {
      mockConnectorsService.resetCircuitBreaker.mockReturnValue([]);

      const result = controller.reset({});

      expect(result).toEqual({ reset: [], count: 0 });
    });
  });
});
