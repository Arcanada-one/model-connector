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
// CONN-0245 — DB-as-source-of-truth model catalog.
import { CatalogRepository } from './catalog.repository';
import { CatalogRefreshService } from './catalog-refresh.service';
import { CATALOG_REDIS_PROVIDER } from './catalog-redis.provider';
// CONN-0245-EXT — provider READ/USE access.
import { ProviderAccessService } from './provider-access.service';

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
  providers: [
    ConnectorsService,
    ModalityCatalogService,
    CatalogRepository,
    CatalogRefreshService,
    CATALOG_REDIS_PROVIDER,
    ProviderAccessService,
  ],
  exports: [ConnectorsService, CatalogRepository, ProviderAccessService],
})
export class ConnectorsModule {}
