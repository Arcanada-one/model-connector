import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { ModalityCatalogService } from './modality-catalog.service';
import { ConnectorsController } from './connectors.controller';
import { QueueModule } from '../queue/queue.module';
import { CursorModule } from './cursor/cursor.module';
import { ClaudeCodeModule } from './claude-code/claude-code.module';
import { GeminiModule } from './gemini/gemini.module';
import { CodexModule } from './codex/codex.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { OpenRouterModule } from './openrouter/openrouter.module';
import { GroqModule } from './groq/groq.module';
import { GrokModule } from './grok/grok.module';
import { ImageGenerationModule } from './image-generation/image-generation.module';
import { OutputGuardModule } from './output-guard/output-guard.module';
import { OpenModelModule } from './openmodel/openmodel.module';
import { CascadeModule } from './cascade/cascade.module';
import { OrqModule } from './orq/orq.module';

@Module({
  imports: [
    QueueModule,
    CursorModule,
    ClaudeCodeModule,
    GeminiModule,
    CodexModule,
    EmbeddingModule,
    OpenRouterModule,
    GroqModule,
    GrokModule,
    ImageGenerationModule,
    OutputGuardModule,
    OpenModelModule,
    CascadeModule,
    OrqModule,
  ],
  controllers: [ConnectorsController],
  providers: [ConnectorsService, ModalityCatalogService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
