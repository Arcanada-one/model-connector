import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { CohereConnector } from './cohere.connector';

@Module({ imports: [forwardRef(() => ConnectorsModule)], providers: [CohereConnector] })
export class CohereModule implements OnModuleInit {
  constructor(
    private readonly cohere: CohereConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}
  onModuleInit(): void {
    this.connectors.register(this.cohere);
  }
}
