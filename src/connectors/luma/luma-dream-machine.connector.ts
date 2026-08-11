export type LumaHttpMethod = 'GET' | 'POST';

export interface LumaHttpRequest {
  method: LumaHttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface LumaHttpTransport {
  request<T>(request: LumaHttpRequest): Promise<T>;
}

export type LumaVideoModel = 'ray-2' | 'ray-flash-2';
export type LumaImageModel = 'photon-1' | 'photon-flash-1';
export type LumaAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '21:9' | '9:21';

export interface LumaImageKeyframe {
  type: 'image';
  url: string;
}

export interface LumaGenerationKeyframe {
  type: 'generation';
  id: string;
}

export interface LumaVideoRequest {
  prompt: string;
  model: LumaVideoModel;
  aspect_ratio?: LumaAspectRatio;
  loop?: boolean;
  keyframes?: {
    frame0?: LumaImageKeyframe | LumaGenerationKeyframe;
    frame1?: LumaImageKeyframe | LumaGenerationKeyframe;
  };
  callback_url?: string;
  resolution?: string;
  duration?: string;
  concepts?: Array<{ key: string }>;
}

export interface LumaWeightedImageReference {
  url: string;
  weight?: number;
}

export interface LumaImageRequest {
  prompt: string;
  model?: LumaImageModel;
  aspect_ratio?: LumaAspectRatio;
  format?: 'jpg' | 'png';
  callback_url?: string;
  image_ref?: LumaWeightedImageReference[];
  style_ref?: LumaWeightedImageReference[];
  character_ref?: Record<string, { images: string[] }>;
  modify_image_ref?: LumaWeightedImageReference;
  sync?: boolean;
  sync_timeout?: number;
}

export interface LumaGenerationAssets {
  video?: string | null;
  image?: string | null;
  [key: string]: unknown;
}

export interface LumaGeneration {
  id: string;
  state: 'dreaming' | 'completed' | 'failed' | (string & {});
  failure_reason?: string | null;
  created_at?: string;
  assets?: LumaGenerationAssets;
  request?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LumaGenerationList {
  generations: LumaGeneration[];
  [key: string]: unknown;
}

export interface LumaPagination {
  limit?: number;
  offset?: number;
}

export interface LumaExtendRequest {
  direction: 'forward' | 'reverse';
  prompt: string;
  model: LumaVideoModel;
}

const DEFAULT_BASE_URL = 'https://api.lumalabs.ai/dream-machine/v1';

export class LumaDreamMachineConnector {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly transport: LumaHttpTransport,
    baseUrl = DEFAULT_BASE_URL,
  ) {
    if (apiKey.trim().length === 0) throw new Error('Luma API key must not be empty');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  createVideo(body: LumaVideoRequest): Promise<LumaGeneration> {
    return this.post('/generations/video', body);
  }

  createImage(body: LumaImageRequest): Promise<LumaGeneration> {
    return this.post('/generations/image', body);
  }

  async extendVideo(
    source: LumaGeneration,
    request: LumaExtendRequest,
  ): Promise<LumaGeneration> {
    if (source.state !== 'completed') {
      throw new Error('Luma video extension requires a completed source generation');
    }
    if (source.id.trim().length === 0) throw new Error('Source generation id must not be empty');
    const frame = request.direction === 'forward' ? 'frame0' : 'frame1';
    return await this.createVideo({
      prompt: request.prompt,
      model: request.model,
      keyframes: { [frame]: { type: 'generation', id: source.id } },
    });
  }

  getGeneration(id: string): Promise<LumaGeneration> {
    if (id.trim().length === 0) throw new Error('Generation id must not be empty');
    return this.transport.request<LumaGeneration>({
      method: 'GET',
      url: `${this.baseUrl}/generations/${encodeURIComponent(id)}`,
      headers: this.authHeaders(),
    });
  }

  async listGenerations(pagination: LumaPagination = {}): Promise<LumaGenerationList> {
    this.validatePagination(pagination);
    const query = new URLSearchParams();
    if (pagination.limit !== undefined) query.set('limit', String(pagination.limit));
    if (pagination.offset !== undefined) query.set('offset', String(pagination.offset));
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return await this.transport.request<LumaGenerationList>({
      method: 'GET',
      url: `${this.baseUrl}/generations${suffix}`,
      headers: this.authHeaders(),
    });
  }

  private post(path: string, body: LumaVideoRequest | LumaImageRequest): Promise<LumaGeneration> {
    return this.transport.request<LumaGeneration>({
      method: 'POST',
      url: `${this.baseUrl}${path}`,
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body,
    });
  }

  private authHeaders(): Record<string, string> {
    return { Accept: 'application/json', Authorization: `Bearer ${this.apiKey}` };
  }

  private validatePagination({ limit, offset }: LumaPagination): void {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error('Pagination limit must be a positive integer');
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      throw new Error('Pagination offset must be a non-negative integer');
    }
  }
}
