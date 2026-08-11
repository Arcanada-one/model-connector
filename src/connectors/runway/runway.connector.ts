import { Inject, Injectable } from '@nestjs/common';
import type {
  RunwayEphemeralUploadTicket,
  RunwayHttpRequest,
  RunwayHttpResponse,
  RunwayHttpTransport,
  RunwayNativeBody,
  RunwayOperation,
  RunwayTask,
  RunwayTaskCreated,
} from './runway.types';

export type {
  RunwayEphemeralUploadTicket,
  RunwayHttpRequest,
  RunwayHttpResponse,
  RunwayHttpTransport,
  RunwayNativeBody,
  RunwayOperation,
  RunwayTask,
  RunwayTaskCreated,
} from './runway.types';

export const RUNWAY_API_VERSION = '2024-11-06';
export const RUNWAY_API_ORIGIN = 'https://api.dev.runwayml.com';
export const RUNWAY_HTTP_TRANSPORT = Symbol('RUNWAY_HTTP_TRANSPORT');
export const RUNWAY_API_KEY = Symbol('RUNWAY_API_KEY');
export const RUNWAY_API_ORIGIN_TOKEN = Symbol('RUNWAY_API_ORIGIN');

export const RUNWAY_OPERATION_ROUTES: Readonly<Record<RunwayOperation, string>> = {
  image_to_video: '/v1/image_to_video',
  text_to_video: '/v1/text_to_video',
  video_to_video: '/v1/video_to_video',
  text_to_image: '/v1/text_to_image',
  image_upscale: '/v1/image_upscale',
  video_upscale: '/v1/video_upscale',
  character_performance: '/v1/character_performance',
  sound_effect: '/v1/sound_effect',
  speech_to_speech: '/v1/speech_to_speech',
  text_to_speech: '/v1/text_to_speech',
  voice_dubbing: '/v1/voice_dubbing',
  voice_isolation: '/v1/voice_isolation',
};

const RUNWAY_TASK_STATUSES = new Set([
  'PENDING',
  'THROTTLED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

@Injectable()
export class RunwayConnector {
  constructor(
    @Inject(RUNWAY_HTTP_TRANSPORT) private readonly transport: RunwayHttpTransport,
    @Inject(RUNWAY_API_KEY) private readonly apiKey: string,
    @Inject(RUNWAY_API_ORIGIN_TOKEN) private readonly origin = RUNWAY_API_ORIGIN,
  ) {
    if (!apiKey.trim()) throw new Error('Runway API key must not be blank');
  }

  async generate(operation: RunwayOperation, body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    const response = await this.request<RunwayTaskCreated>({
      method: 'POST',
      url: `${this.normalizedOrigin()}${RUNWAY_OPERATION_ROUTES[operation]}`,
      body,
    });
    return this.requireCreated(response.data);
  }

  imageToVideo(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('image_to_video', body);
  }

  textToVideo(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('text_to_video', body);
  }

  videoToVideo(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('video_to_video', body);
  }

  textToImage(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('text_to_image', body);
  }

  imageUpscale(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('image_upscale', body);
  }

  videoUpscale(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('video_upscale', body);
  }

  characterPerformance(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('character_performance', body);
  }

  soundEffect(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('sound_effect', body);
  }

  speechToSpeech(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('speech_to_speech', body);
  }

  textToSpeech(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('text_to_speech', body);
  }

  voiceDubbing(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('voice_dubbing', body);
  }

  voiceIsolation(body: RunwayNativeBody): Promise<RunwayTaskCreated> {
    return this.generate('voice_isolation', body);
  }

  async getTask(id: string): Promise<RunwayTask> {
    const taskId = this.requireTaskId(id);
    const response = await this.request<RunwayTask>({
      method: 'GET',
      url: `${this.normalizedOrigin()}/v1/tasks/${taskId}`,
    });
    return this.requireTask(response.data);
  }

  async deleteTask(id: string): Promise<void> {
    const taskId = this.requireTaskId(id);
    await this.request<void>({
      method: 'DELETE',
      url: `${this.normalizedOrigin()}/v1/tasks/${taskId}`,
    });
  }

  async createEphemeralUpload(filename: string): Promise<RunwayEphemeralUploadTicket> {
    if (!filename.trim()) throw new Error('Runway upload filename must not be blank');
    const response = await this.request<RunwayEphemeralUploadTicket>({
      method: 'POST',
      url: `${this.normalizedOrigin()}/v1/uploads`,
      body: { filename, type: 'ephemeral' },
    });
    return this.requireUploadTicket(response.data);
  }

  private request<T>(request: Omit<RunwayHttpRequest, 'headers'>): Promise<RunwayHttpResponse<T>> {
    return this.transport.request<T>({ ...request, headers: this.headers() });
  }

  private headers(): Readonly<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': RUNWAY_API_VERSION,
    };
  }

  private normalizedOrigin(): string {
    return this.origin.replace(/\/+$/, '');
  }

  private requireTaskId(id: string): string {
    const trimmed = id.trim();
    if (!trimmed || trimmed.includes('/')) throw new Error('Runway task id is invalid');
    return trimmed;
  }

  private requireCreated(data: RunwayTaskCreated | undefined): RunwayTaskCreated {
    if (!data || typeof data.id !== 'string' || !data.id) {
      throw new Error('Runway creation response is missing id');
    }
    return data;
  }

  private requireTask(data: RunwayTask | undefined): RunwayTask {
    if (
      !data ||
      typeof data.id !== 'string' ||
      typeof data.status !== 'string' ||
      !RUNWAY_TASK_STATUSES.has(data.status)
    ) {
      throw new Error('Runway task response is malformed');
    }
    return data;
  }

  private requireUploadTicket(
    data: RunwayEphemeralUploadTicket | undefined,
  ): RunwayEphemeralUploadTicket {
    if (
      !data ||
      typeof data.uploadUrl !== 'string' ||
      typeof data.runwayUri !== 'string' ||
      typeof data.fields !== 'object' ||
      data.fields === null
    ) {
      throw new Error('Runway upload response is malformed');
    }
    return data;
  }
}
