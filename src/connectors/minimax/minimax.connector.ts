export const MINIMAX_INTERNATIONAL_BASE_URL = 'https://api.minimax.io/v1';

export const MINIMAX_VIDEO_TASK_STATUSES = [
  'Preparing',
  'Queueing',
  'Processing',
  'Success',
  'Fail',
] as const;

export type MinimaxVideoTaskStatus = (typeof MINIMAX_VIDEO_TASK_STATUSES)[number];

export interface MinimaxTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface MinimaxTransport {
  request<T>(request: MinimaxTransportRequest): Promise<T>;
}

export interface MinimaxBaseResponse {
  status_code: number;
  status_msg: string;
}

interface CommonVideoRequest {
  model: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
  prompt_optimizer?: boolean;
}

export interface MinimaxTextVideoRequest extends CommonVideoRequest {
  first_frame_image?: never;
  last_frame_image?: never;
  subject_reference?: never;
}

export interface MinimaxImageVideoRequest extends CommonVideoRequest {
  first_frame_image: string;
  last_frame_image?: never;
  subject_reference?: never;
}

export interface MinimaxFirstLastFrameVideoRequest extends CommonVideoRequest {
  first_frame_image: string;
  last_frame_image: string;
  subject_reference?: never;
}

export interface MinimaxSubjectReferenceVideoRequest extends CommonVideoRequest {
  subject_reference: Array<{
    type: 'character';
    image: string[];
  }>;
  first_frame_image?: never;
  last_frame_image?: never;
}

export type MinimaxCreateVideoRequest =
  | MinimaxTextVideoRequest
  | MinimaxImageVideoRequest
  | MinimaxFirstLastFrameVideoRequest
  | MinimaxSubjectReferenceVideoRequest;

export interface MinimaxCreateVideoResponse {
  task_id: string;
  base_resp: MinimaxBaseResponse;
}

export interface MinimaxQueryVideoResponse {
  task_id: string;
  status: MinimaxVideoTaskStatus;
  file_id?: string;
  video_width?: number;
  video_height?: number;
  base_resp: MinimaxBaseResponse;
}

export interface MinimaxFileResponse {
  file: {
    file_id: string;
    bytes: number;
    created_at: number;
    filename: string;
    purpose: string;
    download_url: string;
  };
  base_resp: MinimaxBaseResponse;
}

export class MinimaxApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'MinimaxApiError';
  }
}

export class MinimaxConnector {
  constructor(
    private readonly apiKey: string,
    private readonly transport: MinimaxTransport,
  ) {
    if (apiKey.length === 0) {
      throw new Error('MiniMax international API key is required');
    }
  }

  async createVideo(request: MinimaxCreateVideoRequest): Promise<MinimaxCreateVideoResponse> {
    return this.execute<MinimaxCreateVideoResponse>({
      method: 'POST',
      url: `${MINIMAX_INTERNATIONAL_BASE_URL}/video_generation`,
      headers: this.headers(true),
      body: request,
    });
  }

  async queryVideo(taskId: string): Promise<MinimaxQueryVideoResponse> {
    return this.execute<MinimaxQueryVideoResponse>({
      method: 'GET',
      url: `${MINIMAX_INTERNATIONAL_BASE_URL}/query/video_generation`,
      headers: this.headers(false),
      query: { task_id: taskId },
    });
  }

  async retrieveFile(fileId: string): Promise<MinimaxFileResponse> {
    return this.execute<MinimaxFileResponse>({
      method: 'GET',
      url: `${MINIMAX_INTERNATIONAL_BASE_URL}/files/retrieve`,
      headers: this.headers(false),
      query: { file_id: fileId },
    });
  }

  private headers(includeContentType: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async execute<T extends { base_resp: MinimaxBaseResponse }>(
    request: MinimaxTransportRequest,
  ): Promise<T> {
    const response = await this.transport.request<T>(request);
    if (response.base_resp.status_code !== 0) {
      throw new MinimaxApiError(response.base_resp.status_code, response.base_resp.status_msg);
    }
    return response;
  }
}
