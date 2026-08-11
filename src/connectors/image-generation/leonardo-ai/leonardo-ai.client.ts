import { LeonardoApiError, LeonardoProtocolError } from './leonardo-ai.error';
import { encodeMultipart, parsePresignedFields } from './leonardo-ai.multipart';
import type {
  LeonardoAiClientOptions,
  LeonardoCost,
  LeonardoControlNetInput,
  LeonardoCreateGenerationRequest,
  LeonardoCreateGenerationResponse,
  LeonardoCreateInitImageUploadRequest,
  LeonardoCreateInitImageUploadResponse,
  LeonardoCreateNoBackgroundRequest,
  LeonardoCreateNoBackgroundResponse,
  LeonardoCreateUniversalUpscalerRequest,
  LeonardoCreateUniversalUpscalerResponse,
  LeonardoCreateUpscaleRequest,
  LeonardoCreateUpscaleResponse,
  LeonardoDeleteGenerationResponse,
  LeonardoDeleteInitImageResponse,
  LeonardoGeneratedImage,
  LeonardoGeneration,
  LeonardoGenerationStatus,
  LeonardoGenerationVariationAsset,
  LeonardoGetGenerationResponse,
  LeonardoGetInitImageResponse,
  LeonardoGetVariationResponse,
  LeonardoHttpMethod,
  LeonardoInitImageAssetInput,
  LeonardoInitImageUpload,
  LeonardoListPlatformModelsResponse,
  LeonardoPlatformModel,
  LeonardoPollOptions,
  LeonardoPresetStyle,
  LeonardoProviderError,
  LeonardoTransport,
  LeonardoTransportResponse,
  LeonardoVariationAsset,
  LeonardoVariationJob,
} from './leonardo-ai.types';
export const LEONARDO_V1_BASE_URL = 'https://cloud.leonardo.ai/api/rest/v1';
export const LEONARDO_V1_LIMITS = Object.freeze({
  requestsPerMinute: 2000,
  createGenerationPerMinute: 100,
  createVariationPerMinute: 100,
  concurrentImageGenerationJobs: 10,
  pendingImageGenerationJobs: 200,
  pendingUpscalingJobs: 100,
  presignedUploadExpiresInSeconds: 120,
});
type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown, detail: string): UnknownRecord => {
  if (!isRecord(value)) throw new LeonardoProtocolError(detail);
  return value;
};
const string = (value: unknown, detail: string): string => {
  if (typeof value !== 'string') throw new LeonardoProtocolError(detail);
  return value;
};
const integer = (value: unknown, detail: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new LeonardoProtocolError(detail);
  return value;
};
const boolean = (value: unknown, detail: string): boolean => {
  if (typeof value !== 'boolean') throw new LeonardoProtocolError(detail);
  return value;
};
const generationStatus = (value: unknown): LeonardoGenerationStatus => {
  if (value !== 'PENDING' && value !== 'COMPLETE' && value !== 'FAILED') {
    throw new LeonardoProtocolError('invalid generation status');
  }
  return value;
};
const LEONARDO_PRESET_STYLES: readonly LeonardoPresetStyle[] = [
  'ANIME',
  'BOKEH',
  'CINEMATIC',
  'CINEMATIC_CLOSEUP',
  'CREATIVE',
  'DYNAMIC',
  'ENVIRONMENT',
  'FASHION',
  'FILM',
  'FOOD',
  'GENERAL',
  'HDR',
  'ILLUSTRATION',
  'LEONARDO',
  'LONG_EXPOSURE',
  'MACRO',
  'MINIMALISTIC',
  'MONOCHROME',
  'MOODY',
  'NONE',
  'NEUTRAL',
  'PHOTOGRAPHY',
  'PORTRAIT',
  'RAYTRACED',
  'RENDER_3D',
  'RETRO',
  'SKETCH_BW',
  'SKETCH_COLOR',
  'STOCK_PHOTO',
  'VIBRANT',
  'UNPROCESSED',
];
const LEONARDO_CANVAS_REQUEST_TYPES = [
  'INPAINT',
  'OUTPAINT',
  'SKETCH2IMG',
  'IMG2IMG',
] as const satisfies readonly NonNullable<LeonardoCreateGenerationRequest['canvasRequestType']>[];
const LEONARDO_CONTROL_NET_INIT_IMAGE_TYPES = [
  'GENERATED',
  'UPLOADED',
] as const satisfies readonly NonNullable<LeonardoControlNetInput['initImageType']>[];
const LEONARDO_CONTROL_NET_STRENGTH_TYPES = [
  'Low',
  'Mid',
  'High',
  'Ultra',
  'Max',
] as const satisfies readonly NonNullable<LeonardoControlNetInput['strengthType']>[];
const nullableString = (value: unknown, detail: string): string | null => {
  if (value !== null && typeof value !== 'string') throw new LeonardoProtocolError(detail);
  return value;
};
const nullableBoolean = (value: unknown, detail: string): boolean | null => {
  if (value !== null && typeof value !== 'boolean') throw new LeonardoProtocolError(detail);
  return value;
};
const nullableInteger = (value: unknown, detail: string): number | null => {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value))) {
    throw new LeonardoProtocolError(detail);
  }
  return value;
};
const variationAssetFields = (item: Record<string, unknown>): LeonardoGenerationVariationAsset => {
  const transformType = item.transformType;
  if (
    transformType !== undefined &&
    transformType !== 'OUTPAINT' &&
    transformType !== 'INPAINT' &&
    transformType !== 'UPSCALE' &&
    transformType !== 'UNZOOM' &&
    transformType !== 'NOBG'
  ) {
    throw new LeonardoProtocolError('invalid variation transformType');
  }
  return {
    ...(item.id === undefined
      ? {}
      : { id: nullableString(item.id, 'variation id must be a string or null') }),
    ...(item.status === undefined ? {} : { status: generationStatus(item.status) }),
    ...(transformType === undefined ? {} : { transformType }),
    ...(item.url === undefined
      ? {}
      : { url: nullableString(item.url, 'variation url must be string or null') }),
  };
};
const generationVariationAsset = (value: unknown): LeonardoGenerationVariationAsset =>
  variationAssetFields(record(value, 'variation asset must be an object'));
const variationAsset = (value: unknown): LeonardoVariationAsset => {
  const item = record(value, 'variation asset must be an object');
  return {
    ...variationAssetFields(item),
    ...(item.createdAt === undefined
      ? {}
      : { createdAt: string(item.createdAt, 'variation createdAt must be a string') }),
  };
};
const generatedImage = (value: unknown): LeonardoGeneratedImage => {
  const image = record(value, 'generated image must be an object');
  if (
    image.generated_image_variation_generics !== undefined &&
    !Array.isArray(image.generated_image_variation_generics)
  ) {
    throw new LeonardoProtocolError('generated image variations must be an array');
  }
  return {
    ...(image.generated_image_variation_generics === undefined
      ? {}
      : {
          generated_image_variation_generics:
            image.generated_image_variation_generics.map(generationVariationAsset),
        }),
    ...(image.fantasyAvatar === undefined
      ? {}
      : {
          fantasyAvatar: nullableBoolean(
            image.fantasyAvatar,
            'fantasyAvatar must be boolean or null',
          ),
        }),
    ...(image.id === undefined
      ? {}
      : { id: nullableString(image.id, 'generated image id must be a string or null') }),
    ...(image.likeCount === undefined
      ? {}
      : { likeCount: integer(image.likeCount, 'generated image likeCount must be an integer') }),
    ...(image.nsfw === undefined
      ? {}
      : { nsfw: boolean(image.nsfw, 'generated image nsfw must be a boolean') }),
    ...(image.url === undefined
      ? {}
      : { url: string(image.url, 'generated image url must be a string') }),
  };
};
const generationCore = (item: Record<string, unknown>): Partial<LeonardoGeneration> => {
  if (item.generated_images !== undefined && !Array.isArray(item.generated_images)) {
    throw new LeonardoProtocolError('generated_images must be an array');
  }
  return {
    ...(item.createdAt === undefined
      ? {}
      : { createdAt: string(item.createdAt, 'generation createdAt must be a string') }),
    ...(item.generated_images === undefined
      ? {}
      : { generated_images: item.generated_images.map(generatedImage) }),
    ...(item.id === undefined
      ? {}
      : { id: nullableString(item.id, 'generation id must be a string or null') }),
    ...(item.imageHeight === undefined
      ? {}
      : {
          imageHeight: integer(item.imageHeight, 'generation imageHeight must be an integer'),
        }),
    ...(item.imageWidth === undefined
      ? {}
      : {
          imageWidth: integer(item.imageWidth, 'generation imageWidth must be an integer'),
        }),
    ...(item.modelId === undefined
      ? {}
      : { modelId: nullableString(item.modelId, 'generation modelId must be a string or null') }),
    ...(item.prompt === undefined
      ? {}
      : { prompt: string(item.prompt, 'generation prompt must be a string') }),
    ...(item.public === undefined
      ? {}
      : { public: boolean(item.public, 'generation public must be a boolean') }),
    ...(item.status === undefined ? {} : { status: generationStatus(item.status) }),
  };
};
const generation = (value: unknown): LeonardoGeneration => {
  const item = record(value, 'generation must be an object');
  return generationCore(item);
};
const costJob = (value: unknown, detail: string): LeonardoVariationJob => {
  const item = record(value, `${detail} must be an object`);
  return {
    id: string(item.id, `${detail} id must be a string`),
    ...(item.apiCreditCost === undefined
      ? {}
      : {
          apiCreditCost: nullableInteger(
            item.apiCreditCost,
            `${detail} apiCreditCost must be an integer or null`,
          ),
        }),
    ...(item.cost === undefined ? {} : { cost: providerCost(item.cost, `${detail} cost`) }),
  };
};
const providerCost = (value: unknown, detail: string): LeonardoCost | null => {
  if (value === null) return null;
  const item = record(value, `${detail} must be an object or null`);
  if (item.amount !== undefined && typeof item.amount !== 'string') {
    throw new LeonardoProtocolError(`${detail} amount must be a string`);
  }
  if (item.unit !== undefined && item.unit !== 'CREDITS' && item.unit !== 'DOLLARS') {
    throw new LeonardoProtocolError(`${detail} unit must be CREDITS or DOLLARS`);
  }
  return {
    ...(item.amount === undefined ? {} : { amount: item.amount }),
    ...(item.unit === undefined ? {} : { unit: item.unit }),
  };
};
const redact = (value: string, secret: string): string => value.replaceAll(secret, '[REDACTED]');
const providerError = (body: unknown, apiKey: string): Partial<LeonardoProviderError> => {
  if (!isRecord(body)) return {};
  return {
    ...(typeof body.error === 'string' ? { error: redact(body.error, apiKey) } : {}),
    ...(typeof body.path === 'string' ? { path: redact(body.path, apiKey) } : {}),
    ...(typeof body.code === 'string' ? { code: redact(body.code, apiKey) } : {}),
  };
};
const positiveInteger = (value: number, detail: string): void => {
  if (!Number.isInteger(value) || value <= 0) throw new LeonardoProtocolError(detail);
};
const nonNegativeNumber = (value: number, detail: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new LeonardoProtocolError(detail);
};
const validateCreateGenerationIntegerFields = (request: LeonardoCreateGenerationRequest): void => {
  const integerFields = ['height', 'width', 'num_images'] as const;
  for (const field of integerFields) {
    const value = request[field];
    if (value !== undefined && value !== null) {
      integer(value, `generation request ${field} must be an integer or null`);
    }
  }
};
const validateNullableEnumField = (
  value: unknown,
  candidates: readonly string[],
  field: string,
): void => {
  if (
    value !== undefined &&
    value !== null &&
    !candidates.some((candidate) => candidate === value)
  ) {
    throw new LeonardoProtocolError(
      `generation request ${field} must be a recognized value or null`,
    );
  }
};
const validateCreateGenerationEnumFields = (request: LeonardoCreateGenerationRequest): void => {
  validateNullableEnumField(request.presetStyle, LEONARDO_PRESET_STYLES, 'presetStyle');
  validateNullableEnumField(
    request.canvasRequestType,
    LEONARDO_CANVAS_REQUEST_TYPES,
    'canvasRequestType',
  );
};
const validateCreateGenerationControlNets = (request: LeonardoCreateGenerationRequest): void => {
  for (const controlNet of request.controlnets ?? []) {
    if (
      controlNet.initImageType !== undefined &&
      !LEONARDO_CONTROL_NET_INIT_IMAGE_TYPES.some(
        (candidate) => candidate === controlNet.initImageType,
      )
    ) {
      throw new LeonardoProtocolError(
        'generation request controlnets initImageType must be a recognized non-null value',
      );
    }
    validateNullableEnumField(
      controlNet.strengthType,
      LEONARDO_CONTROL_NET_STRENGTH_TYPES,
      'controlnets strengthType',
    );
    if (
      controlNet.preprocessorId !== undefined &&
      (typeof controlNet.preprocessorId !== 'number' || Number.isNaN(controlNet.preprocessorId))
    ) {
      throw new LeonardoProtocolError(
        'generation request controlnets preprocessorId must be a number',
      );
    }
    if (
      controlNet.weight !== undefined &&
      controlNet.weight !== null &&
      (typeof controlNet.weight !== 'number' || Number.isNaN(controlNet.weight))
    ) {
      throw new LeonardoProtocolError(
        'generation request controlnets weight must be a number or null',
      );
    }
  }
};
export class LeonardoAiClient {
  private readonly apiKey: string;
  private readonly transport: LeonardoTransport;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly boundaryFactory: () => string;
  constructor(options: LeonardoAiClientOptions) {
    if (options.apiKey.trim().length === 0 || /[\r\n]/.test(options.apiKey)) {
      throw new LeonardoProtocolError('invalid API key');
    }
    this.apiKey = options.apiKey;
    this.transport = options.transport;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.boundaryFactory = options.boundaryFactory ?? (() => crypto.randomUUID());
  }
  async createGeneration(
    request: LeonardoCreateGenerationRequest,
  ): Promise<LeonardoCreateGenerationResponse> {
    validateCreateGenerationIntegerFields(request);
    validateCreateGenerationEnumFields(request);
    validateCreateGenerationControlNets(request);
    return this.sendJson('POST', '/generations', request, (body) => {
      const root = record(body, 'create generation response must be an object');
      if (root.sdGenerationJob === undefined) return {};
      if (root.sdGenerationJob === null) return { sdGenerationJob: null };
      const job = record(root.sdGenerationJob, 'sdGenerationJob must be an object or null');
      if (job.generationId !== undefined && typeof job.generationId !== 'string') {
        throw new LeonardoProtocolError('sdGenerationJob generationId must be a string');
      }
      if (
        job.apiCreditCost !== undefined &&
        job.apiCreditCost !== null &&
        typeof job.apiCreditCost !== 'number'
      ) {
        throw new LeonardoProtocolError('sdGenerationJob apiCreditCost must be a number or null');
      }
      return {
        sdGenerationJob: {
          ...(job.generationId === undefined ? {} : { generationId: job.generationId }),
          ...(job.apiCreditCost === undefined
            ? {}
            : {
                apiCreditCost: nullableInteger(
                  job.apiCreditCost,
                  'sdGenerationJob apiCreditCost must be an integer or null',
                ),
              }),
          ...(job.cost === undefined
            ? {}
            : { cost: providerCost(job.cost, 'sdGenerationJob cost') }),
        },
      };
    });
  }
  getGeneration(id: string): Promise<LeonardoGetGenerationResponse> {
    return this.sendJson('GET', `/generations/${encodeURIComponent(id)}`, undefined, (body) => {
      const root = record(body, 'get generation response must be an object');
      if (root.generations_by_pk === undefined) return {};
      return {
        generations_by_pk:
          root.generations_by_pk === null ? null : generation(root.generations_by_pk),
      };
    });
  }
  async pollGeneration(
    id: string,
    options: LeonardoPollOptions,
  ): Promise<LeonardoGetGenerationResponse> {
    this.validatePollOptions(options);
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      const response = await this.getGeneration(id);
      const status = response.generations_by_pk?.status;
      if (status === 'COMPLETE' || status === 'FAILED') return response;
      if (attempt < options.maxAttempts) await this.sleep(options.intervalMs);
    }
    throw new LeonardoProtocolError(
      `generation polling exhausted after ${options.maxAttempts} attempt${options.maxAttempts === 1 ? '' : 's'}`,
    );
  }
  deleteGeneration(id: string): Promise<LeonardoDeleteGenerationResponse> {
    return this.sendJson('DELETE', `/generations/${encodeURIComponent(id)}`, undefined, (body) =>
      this.parseDeleted(body, 'delete_generations_by_pk'),
    );
  }
  createInitImageUpload(
    request: LeonardoCreateInitImageUploadRequest,
  ): Promise<LeonardoCreateInitImageUploadResponse> {
    return this.sendJson('POST', '/init-image', request, (body) => {
      const root = record(body, 'init-image upload response must be an object');
      if (root.uploadInitImage === null) return { uploadInitImage: null };
      const upload = record(root.uploadInitImage, 'uploadInitImage must be an object or null');
      for (const key of ['fields', 'id', 'key', 'url'] as const) {
        if (upload[key] !== null && typeof upload[key] !== 'string') {
          throw new LeonardoProtocolError(`uploadInitImage.${key} must be string or null`);
        }
      }
      return { uploadInitImage: upload as unknown as LeonardoInitImageUpload };
    });
  }
  async uploadInitImageAsset(
    upload: LeonardoInitImageUpload,
    file: LeonardoInitImageAssetInput,
  ): Promise<void> {
    if (typeof upload.url !== 'string' || typeof upload.fields !== 'string') {
      throw new LeonardoProtocolError('init-image upload ticket requires url and fields');
    }
    return this.uploadPresignedAsset(upload.url, upload.fields, file);
  }
  private async uploadPresignedAsset(
    url: string,
    fields: string,
    file: LeonardoInitImageAssetInput,
  ): Promise<void> {
    const boundary = this.boundaryFactory();
    const response = await this.transport.request({
      url,
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: encodeMultipart(parsePresignedFields(fields), file, boundary),
    });
    if (response.status !== 204) throw new LeonardoApiError(response.status, {});
  }
  getInitImage(id: string): Promise<LeonardoGetInitImageResponse> {
    return this.sendJson('GET', `/init-image/${encodeURIComponent(id)}`, undefined, (body) => {
      const root = record(body, 'get init-image response must be an object');
      if (root.init_images_by_pk === null) return { init_images_by_pk: null };
      const item = record(root.init_images_by_pk, 'init_images_by_pk must be an object or null');
      return {
        init_images_by_pk: {
          createdAt: string(item.createdAt, 'init image createdAt must be a string'),
          id: string(item.id, 'init image id must be a string'),
          url: string(item.url, 'init image url must be a string'),
        },
      };
    });
  }
  deleteInitImage(id: string): Promise<LeonardoDeleteInitImageResponse> {
    return this.sendJson('DELETE', `/init-image/${encodeURIComponent(id)}`, undefined, (body) =>
      this.parseDeleted(body, 'delete_init_images_by_pk'),
    );
  }
  createUpscale(request: LeonardoCreateUpscaleRequest): Promise<LeonardoCreateUpscaleResponse> {
    return this.sendJson('POST', '/variations/upscale', request, (body) => {
      const root = record(body, 'upscale response must be an object');
      return {
        sdUpscaleJob:
          root.sdUpscaleJob === null ? null : costJob(root.sdUpscaleJob, 'sdUpscaleJob'),
      };
    });
  }
  createNoBackground(
    request: LeonardoCreateNoBackgroundRequest,
  ): Promise<LeonardoCreateNoBackgroundResponse> {
    return this.sendJson('POST', '/variations/nobg', request, (body) => {
      const root = record(body, 'no-background response must be an object');
      return { sdNobgJob: costJob(root.sdNobgJob, 'sdNobgJob') };
    });
  }
  createUniversalUpscaler(
    request: LeonardoCreateUniversalUpscalerRequest,
  ): Promise<LeonardoCreateUniversalUpscalerResponse> {
    return this.sendJson('POST', '/variations/universal-upscaler', request, (body) => {
      const root = record(body, 'universal upscaler response must be an object');
      return { universalUpscaler: costJob(root.universalUpscaler, 'universalUpscaler') };
    });
  }
  getVariation(id: string): Promise<LeonardoGetVariationResponse> {
    return this.sendJson('GET', `/variations/${encodeURIComponent(id)}`, undefined, (body) => {
      const root = record(body, 'get variation response must be an object');
      if (!Array.isArray(root.generated_image_variation_generic)) {
        throw new LeonardoProtocolError('generated_image_variation_generic must be an array');
      }
      return {
        generated_image_variation_generic:
          root.generated_image_variation_generic.map(variationAsset),
      };
    });
  }
  async pollVariation(
    id: string,
    options: LeonardoPollOptions,
  ): Promise<LeonardoGetVariationResponse> {
    this.validatePollOptions(options);
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      const response = await this.getVariation(id);
      const records = response.generated_image_variation_generic;
      if (records.length > 0 && records.every(({ status }) => status !== 'PENDING'))
        return response;
      if (attempt < options.maxAttempts) await this.sleep(options.intervalMs);
    }
    throw new LeonardoProtocolError(
      `variation polling exhausted after ${options.maxAttempts} attempt${options.maxAttempts === 1 ? '' : 's'}`,
    );
  }
  listPlatformModels(): Promise<LeonardoListPlatformModelsResponse> {
    return this.sendJson('GET', '/platformModels', undefined, (body) => {
      const root = record(body, 'platform models response must be an object');
      if (!Array.isArray(root.custom_models)) {
        throw new LeonardoProtocolError('custom_models must be an array');
      }
      return { custom_models: root.custom_models.map(this.parsePlatformModel) };
    });
  }
  private readonly parsePlatformModel = (value: unknown): LeonardoPlatformModel => {
    const item = record(value, 'platform model must be an object');
    const preview = item.generated_image;
    return {
      description: string(item.description, 'platform model description must be a string'),
      featured: boolean(item.featured, 'platform model featured must be a boolean'),
      generated_image:
        preview === null
          ? null
          : {
              id: string(record(preview, 'model preview must be an object').id, 'preview id'),
              url: string(record(preview, 'model preview must be an object').url, 'preview url'),
            },
      id: string(item.id, 'platform model id must be a string'),
      name: string(item.name, 'platform model name must be a string'),
      nsfw: boolean(item.nsfw, 'platform model nsfw must be a boolean'),
    };
  };
  private validatePollOptions(options: LeonardoPollOptions): void {
    positiveInteger(options.maxAttempts, 'maxAttempts must be a positive integer');
    nonNegativeNumber(options.intervalMs, 'intervalMs must be a non-negative finite number');
  }
  private parseDeleted<Key extends string>(
    body: unknown,
    key: Key,
  ): Record<
    Key,
    {
      readonly id: string;
    } | null
  > {
    const root = record(body, 'delete response must be an object');
    if (root[key] === null) return { [key]: null } as Record<Key, null>;
    const deleted = record(root[key], `${key} must be an object or null`);
    return {
      [key]: { id: string(deleted.id, `${key}.id must be a string`) },
    } as Record<
      Key,
      {
        readonly id: string;
      }
    >;
  }
  private async sendJson<T>(
    method: LeonardoHttpMethod,
    path: string,
    body: object | undefined,
    parse: (value: unknown) => T,
    baseUrl = LEONARDO_V1_BASE_URL,
  ): Promise<T> {
    const response = await this.transport.request({
      url: `${baseUrl}${path}`,
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.assertJsonSuccess(response);
    return parse(response.body);
  }
  private assertJsonSuccess(response: LeonardoTransportResponse): void {
    if (response.status < 200 || response.status >= 300) {
      throw new LeonardoApiError(response.status, providerError(response.body, this.apiKey));
    }
    if (response.status !== 200) {
      throw new LeonardoProtocolError(`unexpected Leonardo success status ${response.status}`);
    }
  }
}
