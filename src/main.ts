import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { validateEnv } from './config/env.schema';

async function bootstrap() {
  const config = validateEnv();
  // Keep the validated bind/parser values in primitive local custody before
  // module initialization can acquire or mutate the shared configuration object.
  const HOST = config.HOST;
  if (typeof HOST !== 'string') {
    throw new Error('Validated HOST must remain a string');
  }
  const PORT = config.PORT;
  if (typeof PORT !== 'number') {
    throw new Error('Validated PORT must remain a number');
  }
  const STT_MAX_AUDIO_BYTES = config.STT_MAX_AUDIO_BYTES;
  if (typeof STT_MAX_AUDIO_BYTES !== 'number') {
    throw new Error('Validated STT_MAX_AUDIO_BYTES must remain a number');
  }
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: config.NODE_ENV !== 'test' }),
  );

  // CONN-0102 — multipart parser required by POST /v1/speech/stt.
  // Limit enforces STT_MAX_AUDIO_BYTES one layer above the route handler so
  // oversize uploads are rejected before fully buffering.
  // Cast: @nestjs/platform-fastify pins fastify@5.8.4 transitively while
  // @fastify/multipart targets fastify@5.8.5+ — TypeScript sees two distinct
  // FastifyInstance types. Runtime behaviour is identical; pnpm dedupe is
  // tracked separately.
  await app.register(multipart as never, {
    limits: {
      fileSize: STT_MAX_AUDIO_BYTES,
      files: 1,
      fields: 16,
    },
  });

  await app.listen(PORT, HOST);
  logger.log(`Model Connector running on ${HOST}:${PORT}`);
}

bootstrap();
