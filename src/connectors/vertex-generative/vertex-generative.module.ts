import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { getConfig } from '../../config/env.schema';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { VertexGenerativeConnector } from './vertex-generative.connector';
import {
  VERTEX_GENERATIVE_CONFIG,
  VERTEX_GENERATIVE_TOKEN_PROVIDER,
  VertexBearerTokenProvider,
} from './vertex-generative.tokens';

const unconfiguredTokenProvider: VertexBearerTokenProvider = async () => {
  throw new Error('Vertex bearer-token provider is not configured');
};

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [
    {
      provide: VERTEX_GENERATIVE_CONFIG,
      useFactory: () => {
        const config = getConfig();
        return {
          project: config.VERTEX_GENERATIVE_PROJECT,
          location: config.VERTEX_GENERATIVE_LOCATION,
          models: config.VERTEX_GENERATIVE_MODELS.split(',')
            .map((model) => model.trim())
            .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index),
        };
      },
    },
    { provide: VERTEX_GENERATIVE_TOKEN_PROVIDER, useValue: unconfiguredTokenProvider },
    VertexGenerativeConnector,
  ],
  exports: [VertexGenerativeConnector, VERTEX_GENERATIVE_TOKEN_PROVIDER],
})
export class VertexGenerativeModule implements OnModuleInit {
  constructor(
    private readonly vertex: VertexGenerativeConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.vertex);
  }
}
