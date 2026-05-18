import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { LocalWhisperSttConnector } from './local-whisper-stt.connector';
import { SttQuotaService } from './stt-quota.service';

export interface SttJobData {
  jobId: string;
  audioBase64: string;
  mimeType: string;
  audioBytes: number;
  filename?: string;
  requestId: string;
  apiKeyId: string;
  language?: string;
  model?: string;
  prompt?: string;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * CONN-0104 — async STT worker for the `connector-jobs-stt` queue.
 *
 * Pipeline:
 *   1. Mark `SttTranscription[jobId=...].status = 'processing'`.
 *   2. Hand the audio to `LocalWhisperSttConnector` (semaphore + CB + fetch).
 *   3. On success — update the row with transcription + cost + latency;
 *      commit quota (req++); record `recordStt('success')`.
 *   4. On failure — mark `status='error'` + errorType/errorMessage; record
 *      `recordStt('error')`. Re-throw so BullMQ honours `attempts` retry.
 *
 * Quota is committed only on success — failures should not re-charge the
 * daily ledger (req-count was already pre-incremented at enqueue time by
 * the controller via `precheck`, which is unconditional).
 */
@Processor('connector-jobs-stt')
export class SttJobProcessor extends WorkerHost {
  private readonly logger = new Logger(SttJobProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whisper: LocalWhisperSttConnector,
    private readonly quota: SttQuotaService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job<SttJobData>): Promise<void> {
    const data = job.data;
    this.logger.log(`Processing STT async job ${job.id} (jobId=${data.jobId})`);
    await this.prisma.sttTranscription.update({
      where: { jobId: data.jobId },
      data: { status: 'processing' },
    });

    try {
      const result = await this.whisper.transcribe({
        file: Buffer.from(data.audioBase64, 'base64'),
        filename: data.filename,
        mimeType: data.mimeType,
        audioBytes: data.audioBytes,
        language: data.language,
        model: data.model,
        prompt: data.prompt,
        temperature: data.temperature,
        requestId: data.requestId,
        timeoutMs: data.timeoutMs,
      });

      await this.prisma.sttTranscription.update({
        where: { jobId: data.jobId },
        data: {
          status: 'success',
          provider: this.whisper.provider,
          model: result.model,
          language: result.detectedLanguage,
          audioDurationSeconds: result.audioDurationSeconds,
          transcriptionPreview: result.transcription.slice(0, 80),
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
        },
      });

      this.metrics.recordStt({
        provider: this.whisper.provider,
        model: result.model,
        status: 'success',
        audioDurationSeconds: result.audioDurationSeconds ?? 0,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      });

      // costMicroCents = USD × 100_000_000. Self-hosted whisper returns 0;
      // the req-count still increments inside quota.commit().
      await this.quota.commit(Math.trunc(result.costUsd * 100_000_000), data.requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorType =
        typeof err === 'object' && err !== null && 'type' in err
          ? String((err as { type: unknown }).type)
          : 'unknown_error';
      this.logger.error(`STT async job ${job.id} failed: ${message}`);
      await this.prisma.sttTranscription.update({
        where: { jobId: data.jobId },
        data: {
          status: 'error',
          errorType,
          errorMessage: message.slice(0, 500),
        },
      });
      this.metrics.recordStt({
        provider: this.whisper.provider,
        model: data.model ?? 'unknown',
        status: 'error',
        audioDurationSeconds: 0,
        costUsd: 0,
        latencyMs: 0,
        errorType,
      });
      throw err;
    }
  }
}
