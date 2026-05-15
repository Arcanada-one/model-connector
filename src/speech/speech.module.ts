import { Module } from '@nestjs/common';
import { SpeechController } from './speech.controller';
import { SpeechService } from './speech.service';
import { TranscribatorProxy } from './transcribator.proxy';

@Module({
  controllers: [SpeechController],
  providers: [SpeechService, TranscribatorProxy],
  exports: [SpeechService],
})
export class SpeechModule {}
