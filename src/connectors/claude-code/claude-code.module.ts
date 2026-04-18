import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ClaudeCodeConnector } from './claude-code.connector';
import { ConnectorsService } from '../connectors.service';
import { ConnectorsModule } from '../connectors.module';

@Module({
  imports: [forwardRef(() => ConnectorsModule)],
  providers: [ClaudeCodeConnector],
})
export class ClaudeCodeModule implements OnModuleInit {
  constructor(
    private readonly claudeCode: ClaudeCodeConnector,
    @Inject(forwardRef(() => ConnectorsService))
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.claudeCode);
  }
}
