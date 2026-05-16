import { Module } from '@nestjs/common';
import { DeepgramSttConnector } from './deepgram-stt.connector';

@Module({
  providers: [DeepgramSttConnector],
  exports: [DeepgramSttConnector],
})
export class DeepgramSttModule {}
