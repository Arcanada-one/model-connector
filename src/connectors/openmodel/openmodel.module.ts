import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { OpenModelConnector } from './openmodel.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [OpenModelConnector],
})
export class OpenModelModule implements OnModuleInit {
  constructor(
    private readonly openmodel: OpenModelConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.openmodel);
  }
}
