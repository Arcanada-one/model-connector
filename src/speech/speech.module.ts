import { Module } from '@nestjs/common';
import { SpeechController } from './speech.controller';
import { SpeechService } from './speech.service';
import { TranscribatorProxy } from './transcribator.proxy';
import { GroqSttModule } from './stt/groq-stt.module';
import { DeepgramSttModule } from './stt/deepgram-stt.module';
import { AssemblyAiSttModule } from './stt/assemblyai-stt.module';
import { OpenAiSttModule } from './stt/openai-stt.module';
import { SttRouterService } from './stt/stt-router.service';

@Module({
  imports: [GroqSttModule, DeepgramSttModule, AssemblyAiSttModule, OpenAiSttModule],
  controllers: [SpeechController],
  providers: [SpeechService, TranscribatorProxy, SttRouterService],
  exports: [SpeechService, SttRouterService],
})
export class SpeechModule {}
