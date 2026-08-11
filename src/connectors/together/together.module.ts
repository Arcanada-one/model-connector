import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { TogetherConnector } from './together.connector';

@Module({ imports: [forwardRef(() => ConnectorsModule)], providers: [TogetherConnector] })
export class TogetherModule implements OnModuleInit {
  constructor(
    private readonly together: TogetherConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit(): void {
    this.connectors.register(this.together);
    // Deliberately no refreshModels(): CONN-0249 requires no boot-time network call.
  }
}
