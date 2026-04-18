import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { CursorConnector } from './cursor.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [CursorConnector],
})
export class CursorModule implements OnModuleInit {
  constructor(
    private readonly cursor: CursorConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.cursor);
  }
}
