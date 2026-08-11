import { DynamicModule, Module } from '@nestjs/common';

import { VeoTransport, VertexVeoConfig, VertexVeoConnector } from './vertex-veo.connector';

@Module({})
export class VertexVeoModule {
  static register(config: VertexVeoConfig, transport: VeoTransport): DynamicModule {
    return {
      module: VertexVeoModule,
      providers: [
        { provide: VertexVeoConnector, useValue: new VertexVeoConnector(config, transport) },
      ],
      exports: [VertexVeoConnector],
    };
  }
}
