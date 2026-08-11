import { forwardRef, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConnectorsModule } from '../connectors.module';
import { ConnectorsService } from '../connectors.service';
import { HuggingFaceConnector } from './huggingface.connector';

@Module({ imports: [forwardRef(() => ConnectorsModule)], providers: [HuggingFaceConnector] })
export class HuggingFaceModule implements OnModuleInit {
  constructor(
    private readonly huggingface: HuggingFaceConnector,
    @Inject(forwardRef(() => ConnectorsService)) private readonly connectors: ConnectorsService,
  ) {}
  onModuleInit(): void { this.connectors.register(this.huggingface); }
}
