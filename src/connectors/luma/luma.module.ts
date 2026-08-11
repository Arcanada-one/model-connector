import { DynamicModule, Module } from '@nestjs/common';
import { LumaDreamMachineConnector, type LumaHttpTransport } from './luma-dream-machine.connector';

export const LUMA_DREAM_MACHINE_CONNECTOR = Symbol('LUMA_DREAM_MACHINE_CONNECTOR');

@Module({})
export class LumaModule {
  static withTransport(apiKey: string, transport: LumaHttpTransport, baseUrl?: string): DynamicModule {
    return {
      module: LumaModule,
      providers: [
        {
          provide: LUMA_DREAM_MACHINE_CONNECTOR,
          useValue: new LumaDreamMachineConnector(apiKey, transport, baseUrl),
        },
      ],
      exports: [LUMA_DREAM_MACHINE_CONNECTOR],
    };
  }
}
