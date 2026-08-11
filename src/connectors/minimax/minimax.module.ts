import { Module } from '@nestjs/common';

import { MinimaxConnector } from './minimax.connector';

@Module({})
export class MinimaxModule {
  static create(apiKey: string, transport: ConstructorParameters<typeof MinimaxConnector>[1]) {
    return new MinimaxConnector(apiKey, transport);
  }
}
