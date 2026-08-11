export const VERTEX_AI_TEXT_EMBEDDING_MODELS = [
  'gemini-embedding-001',
  'text-embedding-005',
  'text-multilingual-embedding-002',
] as const;

export const VERTEX_AI_MULTIMODAL_EMBEDDING_MODELS = ['multimodalembedding@001'] as const;

export type VertexAiTextEmbeddingModel = (typeof VERTEX_AI_TEXT_EMBEDDING_MODELS)[number];
export type VertexAiMultimodalEmbeddingModel =
  (typeof VERTEX_AI_MULTIMODAL_EMBEDDING_MODELS)[number];

export type VertexAiEmbeddingTaskType =
  | 'RETRIEVAL_QUERY'
  | 'RETRIEVAL_DOCUMENT'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING'
  | 'QUESTION_ANSWERING'
  | 'FACT_VERIFICATION'
  | 'CODE_RETRIEVAL_QUERY';

export interface VertexAiEmbeddingsAuth {
  readonly projectIdValue: string;
  readonly locationValue: string;
  getAccessToken(): Promise<string>;
}

export interface VertexAiTextEmbeddingInstance {
  content: string;
  taskType?: VertexAiEmbeddingTaskType;
  title?: string;
}

export interface VertexAiTextEmbeddingRequest {
  model: VertexAiTextEmbeddingModel;
  instances: VertexAiTextEmbeddingInstance[];
  parameters?: {
    autoTruncate?: boolean;
    outputDimensionality?: number;
  };
}

interface VertexAiMediaSource {
  bytesBase64Encoded?: string;
  gcsUri?: string;
}

export interface VertexAiImageEmbeddingInput extends VertexAiMediaSource {
  mimeType?: 'image/jpeg' | 'image/png';
}

export interface VertexAiVideoSegmentConfig {
  startOffsetSec?: number;
  endOffsetSec?: number;
  intervalSec?: number;
}

export interface VertexAiVideoEmbeddingInput extends VertexAiMediaSource {
  videoSegmentConfig?: VertexAiVideoSegmentConfig;
}

export interface VertexAiMultimodalEmbeddingRequest {
  model: VertexAiMultimodalEmbeddingModel;
  instance: {
    text?: string;
    image?: VertexAiImageEmbeddingInput;
    video?: VertexAiVideoEmbeddingInput;
  };
  dimension?: 128 | 256 | 512 | 1408;
}

export interface VertexAiTextEmbeddingResult {
  provider: 'vertex-ai';
  model: VertexAiTextEmbeddingModel;
  embeddings: Array<{
    values: number[];
    statistics?: { tokenCount: number; truncated: boolean };
  }>;
  deployedModelId?: string;
}

export interface VertexAiMultimodalEmbeddingResult {
  provider: 'vertex-ai';
  model: VertexAiMultimodalEmbeddingModel;
  textEmbedding?: number[];
  imageEmbedding?: number[];
  videoEmbeddings?: Array<{
    startOffsetSec: number;
    endOffsetSec: number;
    embedding: number[];
  }>;
  deployedModelId?: string;
}

export type VertexAiEmbeddingsErrorKind =
  | 'VALIDATION_ERROR'
  | 'AUTH_ERROR'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_SUCCESS';

export class VertexAiEmbeddingsError extends Error {
  constructor(
    readonly kind: VertexAiEmbeddingsErrorKind,
    message: string,
    readonly httpStatus?: number,
    readonly providerCode?: number,
    readonly providerStatus?: string,
  ) {
    super(message);
    this.name = 'VertexAiEmbeddingsError';
  }
}

interface GoogleCloudErrorBody {
  error?: {
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
}

const RESOURCE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOCATION_SEGMENT = /^[a-z][a-z0-9-]{0,62}$/;
const TEXT_MODELS = new Set<string>(VERTEX_AI_TEXT_EMBEDDING_MODELS);
const MULTIMODAL_MODELS = new Set<string>(VERTEX_AI_MULTIMODAL_EMBEDDING_MODELS);
const DIMENSIONS = new Set<number>([128, 256, 512, 1408]);

function validationError(message: string): never {
  throw new VertexAiEmbeddingsError('VALIDATION_ERROR', message);
}

function isNumberVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(Number.isFinite);
}

function validateMediaSource(source: VertexAiMediaSource, label: string): void {
  const hasBytes = typeof source.bytesBase64Encoded === 'string' && source.bytesBase64Encoded.length > 0;
  const hasGcs = typeof source.gcsUri === 'string' && source.gcsUri.length > 0;
  if (hasBytes === hasGcs) {
    validationError(`${label} must contain exactly one of bytesBase64Encoded or gcsUri`);
  }
  if (hasGcs && !source.gcsUri!.startsWith('gs://')) {
    validationError(`${label}.gcsUri must be a Cloud Storage URI`);
  }
}

function validateOptionalOffset(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    validationError(`${label} must be a non-negative integer`);
  }
}

/**
 * Connector-local AU-028 extension for Vertex AI embeddings.
 *
 * The auth input is structurally compatible with the existing immutable
 * VertexAuthService. This class never discovers credentials itself.
 */
export class VertexAiEmbeddingsConnector {
  constructor(
    private readonly auth: VertexAiEmbeddingsAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getCapabilities() {
    return {
      provider: 'vertex-ai' as const,
      operation: 'embeddings' as const,
      endpoint: 'regional-publisher-predict' as const,
      discovery: 'documentation-static' as const,
      textModels: [...VERTEX_AI_TEXT_EMBEDDING_MODELS],
      multimodalModels: [...VERTEX_AI_MULTIMODAL_EMBEDDING_MODELS],
    };
  }

  async embedText(request: VertexAiTextEmbeddingRequest): Promise<VertexAiTextEmbeddingResult> {
    this.validateBoundary();
    this.validateTextRequest(request);

    const json = await this.predict(request.model, {
      instances: request.instances.map((instance) => ({
        content: instance.content,
        ...(instance.taskType ? { task_type: instance.taskType } : {}),
        ...(instance.title ? { title: instance.title } : {}),
      })),
      ...(request.parameters ? { parameters: request.parameters } : {}),
    });

    return this.normalizeTextResponse(json, request.model);
  }

  async embedMultimodal(
    request: VertexAiMultimodalEmbeddingRequest,
  ): Promise<VertexAiMultimodalEmbeddingResult> {
    this.validateBoundary();
    this.validateMultimodalRequest(request);

    const json = await this.predict(request.model, {
      instances: [request.instance],
      ...(request.dimension !== undefined ? { parameters: { dimension: request.dimension } } : {}),
    });

    return this.normalizeMultimodalResponse(json, request.model);
  }

  private validateBoundary(): void {
    if (!RESOURCE_SEGMENT.test(this.auth.projectIdValue)) {
      validationError('projectId must be a safe Google Cloud resource segment');
    }
    if (!LOCATION_SEGMENT.test(this.auth.locationValue)) {
      validationError('location must be a safe regional DNS/resource segment');
    }
  }

  private validateTextRequest(request: VertexAiTextEmbeddingRequest): void {
    if (!TEXT_MODELS.has(request.model)) validationError('unsupported Vertex AI text embedding model');
    if (!Array.isArray(request.instances) || request.instances.length === 0) {
      validationError('text embedding requires at least one instance');
    }
    if (request.model === 'gemini-embedding-001' && request.instances.length !== 1) {
      validationError('gemini-embedding-001 requires exactly one REST instance');
    }
    if (request.model !== 'gemini-embedding-001' && request.instances.length > 5) {
      validationError('this text embedding model accepts at most five REST instances');
    }
    for (const instance of request.instances) {
      if (typeof instance.content !== 'string' || instance.content.trim().length === 0) {
        validationError('text embedding content must be non-empty');
      }
      if (instance.title !== undefined && instance.taskType !== 'RETRIEVAL_DOCUMENT') {
        validationError('title is only valid for RETRIEVAL_DOCUMENT');
      }
    }
    const outputDimensionality = request.parameters?.outputDimensionality;
    if (outputDimensionality !== undefined) {
      const maximum = request.model === 'gemini-embedding-001' ? 3072 : 768;
      if (!Number.isInteger(outputDimensionality) || outputDimensionality < 1 || outputDimensionality > maximum) {
        validationError(`outputDimensionality must be an integer from 1 to ${maximum}`);
      }
    }
  }

  private validateMultimodalRequest(request: VertexAiMultimodalEmbeddingRequest): void {
    if (!MULTIMODAL_MODELS.has(request.model)) {
      validationError('unsupported Vertex AI multimodal embedding model');
    }
    const { text, image, video } = request.instance;
    if (text === undefined && image === undefined && video === undefined) {
      validationError('multimodal embedding requires text, image, or video');
    }
    if (text !== undefined && (typeof text !== 'string' || text.trim().length === 0)) {
      validationError('multimodal text must be non-empty');
    }
    if (image) {
      validateMediaSource(image, 'image');
      if (image.mimeType !== undefined && !['image/jpeg', 'image/png'].includes(image.mimeType)) {
        validationError('image.mimeType must be image/jpeg or image/png');
      }
    }
    if (video) {
      validateMediaSource(video, 'video');
      const config = video.videoSegmentConfig;
      if (config) {
        validateOptionalOffset(config.startOffsetSec, 'videoSegmentConfig.startOffsetSec');
        validateOptionalOffset(config.endOffsetSec, 'videoSegmentConfig.endOffsetSec');
        validateOptionalOffset(config.intervalSec, 'videoSegmentConfig.intervalSec');
        if (config.intervalSec !== undefined && config.intervalSec < 4) {
          validationError('videoSegmentConfig.intervalSec must be at least 4');
        }
        if (
          config.startOffsetSec !== undefined &&
          config.endOffsetSec !== undefined &&
          config.endOffsetSec < config.startOffsetSec
        ) {
          validationError('videoSegmentConfig.endOffsetSec must not precede startOffsetSec');
        }
      }
    }
    if (request.dimension !== undefined && !DIMENSIONS.has(request.dimension)) {
      validationError('dimension must be 128, 256, 512, or 1408');
    }
  }

  private async predict(model: string, body: unknown): Promise<unknown> {
    const token = await this.auth.getAccessToken();
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new VertexAiEmbeddingsError('AUTH_ERROR', 'Vertex AI access token is empty');
    }

    const location = this.auth.locationValue;
    const project = this.auth.projectIdValue;
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const sanitized = this.redact(await response.text(), token);
      let parsed: GoogleCloudErrorBody = {};
      try {
        parsed = JSON.parse(sanitized) as GoogleCloudErrorBody;
      } catch {
        // A sanitized non-JSON provider body is still safe to surface.
      }
      const provider = parsed.error;
      const message =
        typeof provider?.message === 'string' && provider.message.length > 0
          ? provider.message
          : sanitized.slice(0, 500) || `Vertex AI request failed with HTTP ${response.status}`;
      throw new VertexAiEmbeddingsError(
        'PROVIDER_ERROR',
        message,
        response.status,
        typeof provider?.code === 'number' ? provider.code : undefined,
        typeof provider?.status === 'string' ? provider.status : undefined,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new VertexAiEmbeddingsError(
        'MALFORMED_SUCCESS',
        'Vertex AI returned a malformed embedding success response',
      );
    }
  }

  private normalizeTextResponse(
    json: unknown,
    model: VertexAiTextEmbeddingModel,
  ): VertexAiTextEmbeddingResult {
    const payload = json as {
      predictions?: Array<{
        embeddings?: {
          values?: unknown;
          statistics?: { token_count?: unknown; truncated?: unknown };
        };
      }>;
      deployedModelId?: unknown;
    };
    if (!Array.isArray(payload.predictions) || payload.predictions.length === 0) {
      return this.malformedSuccess();
    }
    const embeddings = payload.predictions.map((prediction) => {
      const values = prediction.embeddings?.values;
      if (!isNumberVector(values)) return this.malformedSuccess();
      const statistics = prediction.embeddings?.statistics;
      if (statistics === undefined) return { values };
      if (typeof statistics.token_count !== 'number' || typeof statistics.truncated !== 'boolean') {
        return this.malformedSuccess();
      }
      return {
        values,
        statistics: { tokenCount: statistics.token_count, truncated: statistics.truncated },
      };
    });
    return {
      provider: 'vertex-ai',
      model,
      embeddings,
      ...(typeof payload.deployedModelId === 'string'
        ? { deployedModelId: payload.deployedModelId }
        : {}),
    };
  }

  private normalizeMultimodalResponse(
    json: unknown,
    model: VertexAiMultimodalEmbeddingModel,
  ): VertexAiMultimodalEmbeddingResult {
    const payload = json as {
      predictions?: Array<{
        textEmbedding?: unknown;
        imageEmbedding?: unknown;
        videoEmbeddings?: unknown;
      }>;
      deployedModelId?: unknown;
    };
    const prediction = payload.predictions?.[0];
    if (!prediction) return this.malformedSuccess();

    const textEmbedding = prediction.textEmbedding;
    const imageEmbedding = prediction.imageEmbedding;
    const rawVideos = prediction.videoEmbeddings;
    if (textEmbedding !== undefined && !isNumberVector(textEmbedding)) return this.malformedSuccess();
    if (imageEmbedding !== undefined && !isNumberVector(imageEmbedding)) return this.malformedSuccess();
    if (rawVideos !== undefined && !Array.isArray(rawVideos)) return this.malformedSuccess();

    const videoEmbeddings = rawVideos?.map((item: unknown) => {
      const video = item as { startOffsetSec?: unknown; endOffsetSec?: unknown; embedding?: unknown };
      if (
        typeof video.startOffsetSec !== 'number' ||
        typeof video.endOffsetSec !== 'number' ||
        !isNumberVector(video.embedding)
      ) {
        return this.malformedSuccess();
      }
      return {
        startOffsetSec: video.startOffsetSec,
        endOffsetSec: video.endOffsetSec,
        embedding: video.embedding,
      };
    });
    if (textEmbedding === undefined && imageEmbedding === undefined && videoEmbeddings === undefined) {
      return this.malformedSuccess();
    }

    return {
      provider: 'vertex-ai',
      model,
      ...(textEmbedding ? { textEmbedding } : {}),
      ...(imageEmbedding ? { imageEmbedding } : {}),
      ...(videoEmbeddings ? { videoEmbeddings } : {}),
      ...(typeof payload.deployedModelId === 'string'
        ? { deployedModelId: payload.deployedModelId }
        : {}),
    };
  }

  private malformedSuccess(): never {
    throw new VertexAiEmbeddingsError(
      'MALFORMED_SUCCESS',
      'Vertex AI returned a malformed embedding success response',
    );
  }

  private redact(value: string, token: string): string {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value
      .replace(new RegExp(escaped, 'g'), '[REDACTED]')
      .replace(/Bearer\s+[^\s"',}\]]+/gi, 'Bearer [REDACTED]');
  }
}
