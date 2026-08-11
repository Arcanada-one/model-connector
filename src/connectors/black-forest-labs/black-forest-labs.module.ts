import { Module } from '@nestjs/common';

import {
  BlackForestLabsConnector,
  type BflBaseUrl,
  type BflTransport,
} from './black-forest-labs.connector';

@Module({})
export class BlackForestLabsModule {
  static create(
    apiKey: string,
    transport: BflTransport,
    baseUrl?: BflBaseUrl,
  ): BlackForestLabsConnector {
    return new BlackForestLabsConnector(apiKey, transport, baseUrl);
  }
}
