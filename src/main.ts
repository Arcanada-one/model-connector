import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { validateEnv } from './config/env.schema';

async function bootstrap() {
  const config = validateEnv();
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
      fileSize: config.STT_MAX_AUDIO_BYTES,
      files: 1,
      fields: 16,
    },
  });

  await app.listen(config.PORT, '0.0.0.0');
  logger.log(`Model Connector running on port ${config.PORT}`);
}

bootstrap();
