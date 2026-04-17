import { Global, Module } from '@nestjs/common';
import { EnvConfig, validateEnv } from './env.schema';

export const ENV_CONFIG = 'ENV_CONFIG';

@Global()
@Module({
  providers: [
    {
      provide: ENV_CONFIG,
      useFactory: (): EnvConfig => validateEnv(),
    },
  ],
  exports: [ENV_CONFIG],
})
export class ConfigModule {}
