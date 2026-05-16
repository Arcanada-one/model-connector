import { Module } from '@nestjs/common';
import { LocalWhisperSttConnector } from './local-whisper-stt.connector';

@Module({
  providers: [LocalWhisperSttConnector],
  exports: [LocalWhisperSttConnector],
})
export class LocalWhisperSttModule {}
