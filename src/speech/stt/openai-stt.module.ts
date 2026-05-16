import { Module } from '@nestjs/common';
import { OpenAiSttConnector } from './openai-stt.connector';

@Module({
  providers: [OpenAiSttConnector],
  exports: [OpenAiSttConnector],
})
export class OpenAiSttModule {}
