import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { StatsModule } from './stats.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatsReadGuard } from './stats-read.guard';

describe('StatsModule wiring', () => {
  it('registers StatsController', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StatsModule) ?? [];
    expect(controllers).toContain(StatsController);
  });

  it('registers StatsService and StatsReadGuard as providers', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StatsModule) ?? [];
    expect(providers).toContain(StatsService);
    expect(providers).toContain(StatsReadGuard);
  });
});
