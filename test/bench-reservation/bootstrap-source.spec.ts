import 'reflect-metadata';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { transformSync } from '@swc/core';

// Exercise the actual entry source. The only substitutions are explicit module
// loading, validated input and Nest application boundaries; no real AppModule,
// listener, provider, identity or credential is activated by this fixture.
const state = vi.hoisted(() => ({
  config: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: 3900, STT_MAX_AUDIO_BYTES: 123456 },
  register: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(undefined),
  log: vi.fn(),
  create: vi.fn(),
}));
vi.mock('../../src/app.module', () => ({ AppModule: class OwnedModuleBoundary {} }));
vi.mock('../../src/config/env.schema', () => ({ validateEnv: () => state.config }));
vi.mock('@nestjs/core', () => ({ NestFactory: { create: state.create } }));
vi.mock('@nestjs/common', async (original) => {
  const actual = await original<typeof import('@nestjs/common')>();
  return {
    ...actual,
    Logger: class OwnedLogBoundary {
      log = state.log;
    },
  };
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('actual entry retains primitive bind and multipart values after shared config mutation', async () => {
  const original = { HOST: '127.0.0.1', PORT: 3900, STT_MAX_AUDIO_BYTES: 123456 };
  Object.assign(state.config, original);
  state.create.mockImplementation(async () => {
    Object.assign(state.config, {
      HOST: 'owned-after-create',
      PORT: 9999,
      STT_MAX_AUDIO_BYTES: 1,
    });
    return { register: state.register, listen: state.listen };
  });
  await import('../../src/main');
  await vi.waitFor(() => expect(state.log).toHaveBeenCalledTimes(1));
  expect(state.listen).toHaveBeenCalledExactlyOnceWith(original.PORT, original.HOST);
  expect(state.register).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
    limits: { fileSize: original.STT_MAX_AUDIO_BYTES, files: 1, fields: 16 },
  });
  expect(state.log).toHaveBeenCalledExactlyOnceWith('Model Connector running on 127.0.0.1:3900');
});

// Compile the complete real entry, preserving its final bootstrap() expression.
// The VM exposes only explicit inert import boundaries. Its returned promise lets
// these negatives observe the real refusal without suppressing unhandled errors.
it.each([
  ['HOST', 42, 'Validated HOST must remain a string'],
  ['PORT', '3900', 'Validated PORT must remain a number'],
  ['STT_MAX_AUDIO_BYTES', false, 'Validated STT_MAX_AUDIO_BYTES must remain a number'],
])('actual entry refuses malformed %s before Nest creation', async (key, value, message) => {
  const config = {
    HOST: '127.0.0.1',
    PORT: 3900,
    STT_MAX_AUDIO_BYTES: 123456,
    NODE_ENV: 'test',
    [key]: value,
  };
  const create = vi.fn(async () => ({ register: vi.fn(), listen: vi.fn() }));
  const boundaries: Record<string, unknown> = {
    'reflect-metadata': {},
    '@nestjs/core': { NestFactory: { create } },
    '@nestjs/platform-fastify': { FastifyAdapter: class {} },
    '@nestjs/common': {
      Logger: class {
        log() {}
      },
    },
    '@fastify/multipart': { __esModule: true, default: () => undefined },
    './app.module': { AppModule: class {} },
    './config/env.schema': { validateEnv: () => config },
  };
  const source = readFileSync('src/main.ts', 'utf8');
  const compiled = transformSync(source, {
    jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
    module: { type: 'commonjs' },
  }).code;
  const result = new Script(compiled, { filename: 'actual-src-main.ts' }).runInNewContext({
    exports: {},
    require: (name: string) => {
      if (!(name in boundaries)) throw new Error(`Undeclared fixture import: ${name}`);
      return boundaries[name];
    },
  });
  await expect(result).rejects.toThrow(message);
  expect(create).not.toHaveBeenCalled();
});
