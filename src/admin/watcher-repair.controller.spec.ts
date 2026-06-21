import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorsService } from '../connectors/connectors.service';
import { WatcherRepairController } from './watcher-repair.controller';

describe('WatcherRepairController', () => {
  it('validates a closed reset body and delegates to the existing seam', () => {
    const service = { resetCircuitBreaker: vi.fn().mockReturnValue([]) };
    const controller = new WatcherRepairController(service as unknown as ConnectorsService);
    expect(controller.reset({ connector: 'openrouter', model: 'm' })).toEqual({
      reset: [],
      count: 0,
    });
    expect(service.resetCircuitBreaker).toHaveBeenCalledWith('openrouter', 'm');
  });

  it.each([{}, { connector: 'openrouter', extra: true }, { connector: '', model: 'm' }])(
    'rejects invalid or over-broad reset bodies',
    (body) => {
      const controller = new WatcherRepairController({
        resetCircuitBreaker: vi.fn(),
      } as unknown as ConnectorsService);
      expect(() => controller.reset(body)).toThrow(BadRequestException);
    },
  );
});
