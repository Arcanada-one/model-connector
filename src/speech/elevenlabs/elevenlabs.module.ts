import { Module } from '@nestjs/common';
import { ElevenLabsConnector } from './elevenlabs.connector';

@Module({ providers: [ElevenLabsConnector], exports: [ElevenLabsConnector] })
export class ElevenLabsModule {}
