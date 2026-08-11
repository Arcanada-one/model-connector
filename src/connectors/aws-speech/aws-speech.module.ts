import { DynamicModule, Module } from '@nestjs/common';
import { AwsSpeechConnector, type AwsSpeechConnectorOptions } from './aws-speech.connector';

export const AWS_SPEECH_SIGNER = Symbol('AWS_SPEECH_SIGNER');
export const AWS_SPEECH_HTTP_TRANSPORT = Symbol('AWS_SPEECH_HTTP_TRANSPORT');
export const AWS_TRANSCRIBE_EVENT_STREAM_TRANSPORT = Symbol(
  'AWS_TRANSCRIBE_EVENT_STREAM_TRANSPORT',
);

@Module({})
export class AwsSpeechModule {
  static forRoot(options: AwsSpeechConnectorOptions): DynamicModule {
    return {
      module: AwsSpeechModule,
      providers: [
        { provide: AWS_SPEECH_SIGNER, useValue: options.signer },
        {
          provide: AWS_SPEECH_HTTP_TRANSPORT,
          useValue: options.httpTransport,
        },
        {
          provide: AWS_TRANSCRIBE_EVENT_STREAM_TRANSPORT,
          useValue: options.eventStreamTransport,
        },
        {
          provide: AwsSpeechConnector,
          useFactory: () => new AwsSpeechConnector(options),
        },
      ],
      exports: [
        AwsSpeechConnector,
        AWS_SPEECH_SIGNER,
        AWS_SPEECH_HTTP_TRANSPORT,
        AWS_TRANSCRIBE_EVENT_STREAM_TRANSPORT,
      ],
    };
  }
}
