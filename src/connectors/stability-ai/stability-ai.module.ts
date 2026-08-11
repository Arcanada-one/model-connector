import { Module } from '@nestjs/common';

import { StabilityAiConnector, type StabilityAiTransport } from './stability-ai.connector';

@Module({})
export class StabilityAiModule {
  static create(bearerToken: string, transport: StabilityAiTransport): StabilityAiConnector {
    return new StabilityAiConnector(bearerToken, transport);
  }
}
