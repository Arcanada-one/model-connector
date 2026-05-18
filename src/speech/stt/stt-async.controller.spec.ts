import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SttQuotaService } from './stt-quota.service';

// Mock BullMQ decorators so we can construct the controller without a
// running Redis. Per memory `feedback_redis_lua_vs_multi`.
vi.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => {},
  BullModule: { registerQueue: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn().mockResolvedValue({ id: 'bull-job-1' });
  },
}));

import { SttAsyncController } from './stt-async.controller';

interface MockRequest extends FastifyRequest {
  apiKey?: { id: string };
}

interface MockReply {
  status: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function makeReply(): MockReply {
  const reply = {
    status: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

const prismaMock = {
  sttTranscription: {
    create: vi.fn(),
    findFirst: vi.fn(),
  },
} as unknown as PrismaService;

const quotaMock = {
  precheck: vi.fn(),
  commit: vi.fn(),
} as unknown as SttQuotaService;

const queueMock = { add: vi.fn().mockResolvedValue({ id: 'bull-job-1' }) };

function makeMultipartReq(opts?: {
  apiKey?: { id: string } | undefined;
  fileBuf?: Buffer | undefined;
  mimeType?: string;
  fields?: Record<string, { value?: string }>;
}): MockRequest {
  const buf = opts?.fileBuf ?? Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const fileObj = {
    file: undefined as unknown,
    filename: 'sample.wav',
    mimetype: opts?.mimeType ?? 'audio/wav',
    fields: opts?.fields ?? {},
    toBuffer: vi.fn().mockResolvedValue(buf),
  };
  const req = {
    apiKey: opts && 'apiKey' in opts ? opts.apiKey : { id: 'key-abc' },
    file: vi.fn().mockResolvedValue(fileObj),
  } as unknown as MockRequest;
  return req;
}

describe('SttAsyncController', () => {
  let controller: SttAsyncController;

  beforeEach(() => {
    vi.clearAllMocks();
    queueMock.add.mockResolvedValue({ id: 'bull-job-1' });
    (prismaMock.sttTranscription.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    controller = new SttAsyncController(prismaMock, quotaMock, queueMock as never);
  });

  describe('POST /async', () => {
    it('returns 202 with job_id + status_url + status=queued', async () => {
      vi.mocked(quotaMock.precheck).mockResolvedValue({
        allowed: true,
        dailyCostMicroCents: 0,
        dailyReqCount: 0,
      });
      const req = makeMultipartReq();
      const reply = makeReply();
      await controller.submit(undefined, req, reply as unknown as FastifyReply);

      expect(reply.status).toHaveBeenCalledWith(202);
      const body = reply.send.mock.calls[0][0] as {
        job_id: string;
        status: string;
        status_url: string;
      };
      expect(body.status).toBe('queued');
      expect(body.job_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.status_url).toContain(body.job_id);
      expect(prismaMock.sttTranscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mode: 'async',
            status: 'queued',
            jobId: body.job_id,
            apiKeyId: 'key-abc',
            provider: 'local-whisper',
          }),
        }),
      );
      expect(queueMock.add).toHaveBeenCalledWith(
        'transcribe',
        expect.objectContaining({
          jobId: body.job_id,
          apiKeyId: 'key-abc',
        }),
      );
    });

    it('returns 503 stt_budget_exhausted when quota precheck disallows', async () => {
      vi.mocked(quotaMock.precheck).mockResolvedValue({
        allowed: false,
        dailyCostMicroCents: 1_000_000_000,
        dailyReqCount: 5_000,
      });
      const req = makeMultipartReq();
      const reply = makeReply();
      await controller.submit(undefined, req, reply as unknown as FastifyReply);

      expect(reply.status).toHaveBeenCalledWith(503);
      const body = reply.send.mock.calls[0][0] as {
        error_code: string;
        details: { providers_tried: string[] };
      };
      expect(body.error_code).toBe('stt_budget_exhausted');
      expect(body.details.providers_tried).toContain('local-whisper');
      expect(queueMock.add).not.toHaveBeenCalled();
      expect(prismaMock.sttTranscription.create).not.toHaveBeenCalled();
    });

    it('returns 401 stt_validation_error envelope when no apiKey', async () => {
      const req = makeMultipartReq({ apiKey: undefined });
      const reply = makeReply();
      await controller.submit(undefined, req, reply as unknown as FastifyReply);
      expect(reply.status).toHaveBeenCalledWith(401);
    });

    it('returns 400 stt_unsupported_mime when MIME not whitelisted', async () => {
      vi.mocked(quotaMock.precheck).mockResolvedValue({
        allowed: true,
        dailyCostMicroCents: 0,
        dailyReqCount: 0,
      });
      const req = makeMultipartReq({ mimeType: 'video/mp4' });
      const reply = makeReply();
      await controller.submit(undefined, req, reply as unknown as FastifyReply);
      expect(reply.status).toHaveBeenCalledWith(400);
      const body = reply.send.mock.calls[0][0] as { error_code: string };
      expect(body.error_code).toBe('stt_unsupported_mime');
    });
  });

  describe('GET /jobs/:id', () => {
    it('returns status=queued with no result block when row queued', async () => {
      (prismaMock.sttTranscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: 'jid-1',
        status: 'queued',
        provider: 'local-whisper',
        model: 'm',
        transcriptionPreview: '',
        language: null,
        audioDurationSeconds: null,
        costUsd: 0,
        latencyMs: 0,
        errorType: null,
        errorMessage: null,
      });
      const req = { apiKey: { id: 'key-abc' } } as MockRequest;
      const out = await controller.getJobStatus('jid-1', req);
      expect(out.status).toBe('queued');
      expect(out.result).toBeUndefined();
      expect(out.error).toBeUndefined();
    });

    it('returns status=completed + result on success', async () => {
      (prismaMock.sttTranscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: 'jid-2',
        status: 'success',
        provider: 'local-whisper',
        model: 'Systran/faster-distil-whisper-large-v3',
        transcriptionPreview: 'hello world',
        language: 'en',
        audioDurationSeconds: 1.5,
        costUsd: 0,
        latencyMs: 1234,
        errorType: null,
        errorMessage: null,
      });
      const req = { apiKey: { id: 'key-abc' } } as MockRequest;
      const out = await controller.getJobStatus('jid-2', req);
      expect(out.status).toBe('completed');
      expect(out.result?.transcription).toBe('hello world');
      expect(out.result?.provider).toBe('local-whisper');
      expect(out.result?.cost_usd).toBe(0);
    });

    it('returns status=failed + error on error row', async () => {
      (prismaMock.sttTranscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: 'jid-3',
        status: 'error',
        provider: 'local-whisper',
        model: 'm',
        transcriptionPreview: '',
        language: null,
        audioDurationSeconds: null,
        costUsd: 0,
        latencyMs: 0,
        errorType: 'server_error',
        errorMessage: 'whisper 503',
      });
      const req = { apiKey: { id: 'key-abc' } } as MockRequest;
      const out = await controller.getJobStatus('jid-3', req);
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('server_error');
      expect(out.error?.message).toBe('whisper 503');
    });

    it('404s on missing row OR apiKeyId mismatch (no info leak)', async () => {
      (prismaMock.sttTranscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const req = { apiKey: { id: 'key-other' } } as MockRequest;
      await expect(controller.getJobStatus('jid-x', req)).rejects.toThrow();
    });
  });
});
