import { DynamicModule, Module } from '@nestjs/common';
import { AzureSpeechConnector } from './azure-speech.connector';
import type { AzureSpeechConnectorOptions } from './types';

@Module({})
export class AzureSpeechModule {
  static forRoot(options: AzureSpeechConnectorOptions): DynamicModule {
    return {
      module: AzureSpeechModule,
      providers: [
        {
          provide: AzureSpeechConnector,
          useFactory: () => new AzureSpeechConnector(options),
        },
      ],
      exports: [AzureSpeechConnector],
    };
  }
}
