import { DynamicModule, Module } from '@nestjs/common';
import {
  RUNWAY_API_KEY,
  RUNWAY_API_ORIGIN,
  RUNWAY_API_ORIGIN_TOKEN,
  RUNWAY_HTTP_TRANSPORT,
  RunwayConnector,
} from './runway.connector';
import type { RunwayHttpTransport } from './runway.types';

export interface RunwayModuleOptions {
  apiKey: string;
  transport: RunwayHttpTransport;
  origin?: string;
}

@Module({})
export class RunwayModule {
  static register(options: RunwayModuleOptions): DynamicModule {
    return {
      module: RunwayModule,
      providers: [
        RunwayConnector,
        { provide: RUNWAY_HTTP_TRANSPORT, useValue: options.transport },
        { provide: RUNWAY_API_KEY, useValue: options.apiKey },
        { provide: RUNWAY_API_ORIGIN_TOKEN, useValue: options.origin ?? RUNWAY_API_ORIGIN },
      ],
      exports: [RunwayConnector],
    };
  }
}
