import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MetricsService } from '../../metrics/metrics.service';

// Per memory `feedback_redis_lua_vs_multi`: ioredis-mock is too thin; we
// mock BullMQ decorators so the processor instantiates without Redis.
vi.mock('@nestjs/bullmq', () => ({
  Processor: () => () => {},
  WorkerHost: class {
    process(_job: unknown): Promise<unknown> {
      return Promise.resolve(null);
    }
  },
  InjectQueue: () => () => {},
  BullModule: { registerQueue: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Job: class {},
  Queue: class {
    add = vi.fn();
    getJob = vi.fn();
  },
}));

import { SttJobProcessor, type SttJobData } from './stt-job.processor';
import type { LocalWhisperSttConnector } from './local-whisper-stt.connector';
import type { SttQuotaService } from './stt-quota.service';
import type { SttConnectorResult } from './interfaces/stt-connector.interface';

const prismaMock = {
  sttTranscription: {
    update: vi.fn(),
  },
} as unknown as PrismaService;

const whisperMock = {
  name: 'local-whisper',
  provider: 'local-whisper',
  transcribe: vi.fn(),
} as unknown as LocalWhisperSttConnector;

const quotaMock = {
  precheck: vi.fn(),
  commit: vi.fn(),
} as unknown as SttQuotaService;

const metricsMock = {
  recordStt: vi.fn(),
} as unknown as MetricsService;

function makeJobData(overrides: Partial<SttJobData> = {}): SttJobData {
  return {
    jobId: '0194f2a0-1234-7000-8000-000000000001',
    audioBase64: Buffer.from([0xff, 0xfb, 0x90, 0x00]).toString('base64'),
    mimeType: 'audio/wav',
    audioBytes: 4,
    filename: 'sample.wav',
    requestId: 'req-async-1',
    apiKeyId: 'key-abc',
    language: 'en',
    ...overrides,
  };
}

describe('SttJobProcessor', () => {
  let processor: SttJobProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new SttJobProcessor(prismaMock, whisperMock, quotaMock, metricsMock);
  });

  it('marks row processing → completed on success and commits quota', async () => {
    const result: SttConnectorResult = {
      transcription: 'hello world',
      detectedLanguage: 'en',
      audioDurationSeconds: 2.5,
      model: 'Systran/faster-distil-whisper-large-v3',
      costUsd: 0,
      latencyMs: 1234,
    };
    vi.mocked(whisperMock.transcribe).mockResolvedValue(result);
    (prismaMock.sttTranscription.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const data = makeJobData();
    await processor.process({ id: 'bull-1', data } as unknown as Job<SttJobData>);

    // First update: status='processing'.
    expect(prismaMock.sttTranscription.update).toHaveBeenNthCalledWith(1, {
      where: { jobId: data.jobId },
      data: { status: 'processing' },
    });
    // Second update: status='success' + transcription preview + cost/latency.
    expect(prismaMock.sttTranscription.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { jobId: data.jobId },
        data: expect.objectContaining({
          status: 'success',
          transcriptionPreview: 'hello world',
          costUsd: 0,
          latencyMs: 1234,
          audioDurationSeconds: 2.5,
          language: 'en',
          model: 'Systran/faster-distil-whisper-large-v3',
        }),
      }),
    );
    // Quota commit fires with cost converted to micro-cents (0 here).
    expect(quotaMock.commit).toHaveBeenCalledWith(0, data.requestId);
    // Metrics record.
    expect(metricsMock.recordStt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'local-whisper',
        model: 'Systran/faster-distil-whisper-large-v3',
        status: 'success',
        audioDurationSeconds: 2.5,
        costUsd: 0,
        latencyMs: 1234,
      }),
    );
  });

  it('marks row failed and records error metric on transcription failure', async () => {
    vi.mocked(whisperMock.transcribe).mockRejectedValue(
      Object.assign(new Error('whisper server 503'), { type: 'server_error' }),
    );
    (prismaMock.sttTranscription.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const data = makeJobData();
    await expect(
      processor.process({ id: 'bull-2', data } as unknown as Job<SttJobData>),
    ).rejects.toThrow();

    // Final update marks failure.
    expect(prismaMock.sttTranscription.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { jobId: data.jobId },
        data: expect.objectContaining({
          status: 'error',
          errorMessage: expect.stringContaining('whisper server 503'),
        }),
      }),
    );
    // No quota commit on failure (cost not incurred — only req-count was
    // pre-decremented at enqueue time; failures don't re-charge).
    expect(quotaMock.commit).not.toHaveBeenCalled();
    expect(metricsMock.recordStt).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('truncates transcription preview to 80 chars', async () => {
    const longText = 'x'.repeat(200);
    vi.mocked(whisperMock.transcribe).mockResolvedValue({
      transcription: longText,
      detectedLanguage: 'en',
      audioDurationSeconds: 1,
      model: 'm',
      costUsd: 0,
      latencyMs: 1,
    });
    (prismaMock.sttTranscription.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await processor.process({
      id: 'bull-3',
      data: makeJobData(),
    } as unknown as Job<SttJobData>);

    const callArgs = (prismaMock.sttTranscription.update as ReturnType<typeof vi.fn>).mock
      .calls[1][0] as { data: { transcriptionPreview: string } };
    expect(callArgs.data.transcriptionPreview.length).toBe(80);
  });
});
