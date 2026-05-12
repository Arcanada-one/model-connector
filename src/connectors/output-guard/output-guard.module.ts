// CONN-0089 — Output guard module. Provides OutputGuardMiddleware + a
// runtime config derived from env so ConnectorsModule can import it without
// circular import on config layer.

import { Module } from '@nestjs/common';

import { getConfig } from '../../config/env.schema';
import {
  OUTPUT_GUARD_CONFIG,
  OutputGuardMiddleware,
  type OutputGuardRuntimeConfig,
} from './output-guard.middleware';

@Module({
  providers: [
    {
      provide: OUTPUT_GUARD_CONFIG,
      useFactory: (): OutputGuardRuntimeConfig => {
        try {
          const cfg = getConfig();
          return {
            enabled: cfg.OUTPUT_GUARD_ENABLED,
            maxRetries: cfg.OUTPUT_GUARD_MAX_RETRIES,
            timeoutMs: cfg.OUTPUT_GUARD_TIMEOUT_MS,
          };
        } catch {
          return { enabled: true, maxRetries: 3, timeoutMs: 30_000 };
        }
      },
    },
    OutputGuardMiddleware,
  ],
  exports: [OutputGuardMiddleware],
})
export class OutputGuardModule {}
