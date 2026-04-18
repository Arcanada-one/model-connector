import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { EmbeddingConnector } from './embedding.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [EmbeddingConnector],
})
export class EmbeddingModule implements OnModuleInit {
  constructor(
    private readonly embedding: EmbeddingConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.embedding);
  }
}
