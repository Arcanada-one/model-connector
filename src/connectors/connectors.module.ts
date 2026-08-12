import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { ModalityCatalogService } from './modality-catalog.service';
import { ConnectorsController } from './connectors.controller';
import { QueueModule } from '../queue/queue.module';
import { CursorModule } from './cursor/cursor.module';
import { ClaudeCodeModule } from './claude-code/claude-code.module';
import { GeminiModule } from './gemini/gemini.module';
import { GeminiApiModule } from './gemini-api/gemini-api.module';
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
import { OpenAiModule } from './openai/openai.module';
import { AnthropicModule } from './anthropic/anthropic.module';
import { AzureOpenAiModule } from './azure-openai/azure-openai.module';
import { BedrockModule } from './bedrock/bedrock.module';
import { VertexGenerativeModule } from './vertex-generative/vertex-generative.module';
import { MistralModule } from './mistral/mistral.module';
import { CohereModule } from './cohere/cohere.module';
import { DeepSeekModule } from './deepseek/deepseek.module';
import { TogetherModule } from './together/together.module';
import { FireworksModule } from './fireworks/fireworks.module';
import { CerebrasModule } from './cerebras/cerebras.module';
import { CloudflareWorkersAiModule } from './cloudflare-workers-ai/cloudflare-workers-ai.module';
import { HuggingFaceModule } from './huggingface/huggingface.module';
import { PerplexityModule } from './perplexity/perplexity.module';
import { OllamaModule } from './ollama/ollama.module';
import { OllamaCloudModule } from './ollama-cloud/ollama-cloud.module';
import { ModalModule } from './modal/modal.module';
import { NovaMediaModule } from './bedrock/nova-media/nova-media.module';
// CONN-0245 — DB-as-source-of-truth model catalog.
import { CatalogRepository } from './catalog.repository';
import { CatalogRefreshService } from './catalog-refresh.service';
import { CATALOG_REDIS_PROVIDER } from './catalog-redis.provider';
// CONN-0245-EXT — provider READ/USE access.
import { ProviderAccessService } from './provider-access.service';
// CONN-1665 — per-API-key access policy.
import { PolicyModule } from '../policy/policy.module';

@Module({
  imports: [
    QueueModule,
    CursorModule,
    ClaudeCodeModule,
    GeminiModule,
    GeminiApiModule,
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
    OpenAiModule,
    AnthropicModule,
    AzureOpenAiModule,
    BedrockModule,
    VertexGenerativeModule,
    MistralModule,
    CohereModule,
    DeepSeekModule,
    TogetherModule,
    FireworksModule,
    CerebrasModule,
    CloudflareWorkersAiModule,
    HuggingFaceModule,
    PerplexityModule,
    OllamaModule,
    OllamaCloudModule,
    ModalModule,
    NovaMediaModule,
    // CONN-1665 — per-API-key access policy (PolicyService for the choke point).
    PolicyModule,
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
