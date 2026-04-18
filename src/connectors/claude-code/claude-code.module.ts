import { Module, OnModuleInit } from '@nestjs/common';
import { ClaudeCodeConnector } from './claude-code.connector';
import { ConnectorsService } from '../connectors.service';

@Module({
  providers: [ClaudeCodeConnector],
})
export class ClaudeCodeModule implements OnModuleInit {
  constructor(
    private readonly claudeCode: ClaudeCodeConnector,
    private readonly connectors: ConnectorsService,
  ) {}

  onModuleInit() {
    this.connectors.register(this.claudeCode);
  }
}
