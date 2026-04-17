import { Module, OnModuleInit } from '@nestjs/common';
import { CursorConnector } from './cursor.connector';
import { ConnectorsService } from '../connectors.service';

@Module({
  providers: [CursorConnector],
})
export class CursorModule implements OnModuleInit {
  constructor(
    private readonly cursor: CursorConnector,
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.cursor);
  }
}
