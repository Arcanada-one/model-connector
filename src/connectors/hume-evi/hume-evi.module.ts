import { DynamicModule, Module } from '@nestjs/common';
import { HumeEviConnector } from './hume-evi.connector';
import type { HumeHttpTransport } from './hume-evi.types';

@Module({})
export class HumeEviModule {
  static register(httpTransport: HumeHttpTransport): DynamicModule {
    return {
      module: HumeEviModule,
      providers: [
        {
          provide: HumeEviConnector,
          useFactory: () => new HumeEviConnector({ httpTransport }),
        },
      ],
      exports: [HumeEviConnector],
    };
  }
}
