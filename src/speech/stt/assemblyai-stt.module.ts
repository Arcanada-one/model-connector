import { Module } from '@nestjs/common';
import { AssemblyAiSttConnector } from './assemblyai-stt.connector';

@Module({
  providers: [AssemblyAiSttConnector],
  exports: [AssemblyAiSttConnector],
})
export class AssemblyAiSttModule {}
