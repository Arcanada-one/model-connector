import { Inject, Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ENV_CONFIG } from '../../config/config.module';
import type { EnvConfig } from '../../config/env.schema';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';
import {
  BedrockConnector,
  BedrockSignerNotConfiguredError,
  type BedrockFetch,
  type BedrockSigner,
} from './bedrock.connector';

export const BEDROCK_SIGNER = Symbol('BEDROCK_SIGNER');
export const BEDROCK_FETCH = Symbol('BEDROCK_FETCH');

export function createUnconfiguredBedrockSigner(): BedrockSigner {
  return async () => {
    throw new BedrockSignerNotConfiguredError();
  };
}

export function resolveBedrockSigner(moduleRef: ModuleRef): BedrockSigner {
  try {
    return moduleRef.get<BedrockSigner>(BEDROCK_SIGNER, { strict: false });
  } catch {
    return createUnconfiguredBedrockSigner();
  }
}

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [
    {
      provide: BEDROCK_FETCH,
      useValue: ((url: string, init: RequestInit) => fetch(url, init)) satisfies BedrockFetch,
    },
    {
      provide: BedrockConnector,
      inject: [ENV_CONFIG, BEDROCK_FETCH, ModuleRef],
      useFactory: (config: EnvConfig, fetchFn: BedrockFetch, moduleRef: ModuleRef) => {
        const signer = resolveBedrockSigner(moduleRef);
        return new BedrockConnector(
          { BEDROCK_REGION: config.BEDROCK_REGION, BEDROCK_MODELS: config.BEDROCK_MODELS },
          signer,
          fetchFn,
        );
      },
    },
  ],
  exports: [BedrockConnector],
})
export class BedrockModule implements OnModuleInit {
  constructor(
    private readonly bedrock: BedrockConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.bedrock);
  }
}
