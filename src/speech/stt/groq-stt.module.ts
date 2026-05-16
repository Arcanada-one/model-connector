import { Module } from '@nestjs/common';
import { GroqSttConnector } from './groq-stt.connector';

@Module({
  providers: [GroqSttConnector],
  exports: [GroqSttConnector],
})
export class GroqSttModule {}
