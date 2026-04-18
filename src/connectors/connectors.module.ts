import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { ConnectorsController } from './connectors.controller';
import { QueueModule } from '../queue/queue.module';
import { CursorModule } from './cursor/cursor.module';
import { ClaudeCodeModule } from './claude-code/claude-code.module';

@Module({
  imports: [QueueModule, CursorModule, ClaudeCodeModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
