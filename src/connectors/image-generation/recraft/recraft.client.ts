import { RecraftError } from './recraft.error';
import type {
  BasicStyle,
  CreateStyleRequest,
  CreateStyleResponse,
  CreativeUpscaleRequest,
  CrispUpscaleRequest,
  DeleteStyleResponse,
  EraseRegionRequest,
  ExploreRequest,
  ExploreSimilarRequest,
  GenerateBackgroundRequest,
  GenerateImageResponse,
  GenerateRequest,
  GenerateRasterRequest,
  GenerateVectorRequest,
  ImageToImageRequest,
  InpaintRequest,
  ListBasicStylesResponse,
  ListStylesResponse,
  OutpaintRequest,
  ProcessImageResponse,
  RecraftBinaryAsset,
  RecraftImage,
  RecraftStyle,
  RemoveBackgroundRequest,
  ReplaceBackgroundRequest,
  VariateImageRequest,
  VectorizeRequest,
} from './recraft.types';

export type RecraftTransport = typeof fetch;

const OFFICIAL_BASE_URL = 'https://external.api.recraft.ai';
const FIRST_PARTY_MODELS = new Set([
  'recraftv4_1',
  'recraftv4_1_pro',
  'recraftv4_1_utility',
  'recraftv4_1_utility_pro',
  'recraftv4',
  'recraftv4_pro',
  'recraftv3',
  'recraftv2',
  'recraftv4_1_vector',
  'recraftv4_1_pro_vector',
  'recraftv4_1_utility_vector',
  'recraftv4_1_utility_pro_vector',
  'recraftv4_vector',
  'recraftv4_pro_vector',
  'recraftv3_vector',
  'recraftv2_vector',
]);

export class RecraftClient {
  readonly #apiToken: string;
  readonly #transport: RecraftTransport;
  readonly #baseUrl: string;

  constructor(apiToken: string, transport: RecraftTransport = fetch, baseUrl = OFFICIAL_BASE_URL) {
    this.#apiToken = apiToken;
    this.#transport = transport;
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  generateRaster(request: GenerateRasterRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/generations/raster', request, isGenerateImageResponse);
  }

  generateVector(request: GenerateVectorRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/generations/vector', request, isGenerateImageResponse);
  }

  generate(request: GenerateRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/generations', request, isGenerateImageResponse);
  }

  imageToImage(request: ImageToImageRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/imageToImage', request, isGenerateImageResponse);
  }

  inpaint(request: InpaintRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/inpaint', request, isGenerateImageResponse);
  }

  outpaint(request: OutpaintRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/outpaint', request, isGenerateImageResponse);
  }

  replaceBackground(request: ReplaceBackgroundRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/replaceBackground', request, isGenerateImageResponse);
  }

  generateBackground(request: GenerateBackgroundRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/generateBackground', request, isGenerateImageResponse);
  }

  removeBackground(request: RemoveBackgroundRequest): Promise<ProcessImageResponse> {
    return this.#request('/v1/images/removeBackground', request, isProcessImageResponse);
  }

  vectorize(request: VectorizeRequest): Promise<ProcessImageResponse> {
    return this.#request('/v1/images/vectorize', request, isProcessImageResponse);
  }

  createStyle(request: CreateStyleRequest): Promise<CreateStyleResponse> {
    return this.#request('/v1/styles', request, isCreateStyleResponse);
  }

  eraseRegion(request: EraseRegionRequest): Promise<ProcessImageResponse> {
    return this.#request('/v1/images/eraseRegion', request, isProcessImageResponse);
  }

  variateImage(request: VariateImageRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/variateImage', request, isGenerateImageResponse);
  }

  explore(request: ExploreRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/explore', request, isGenerateImageResponse);
  }

  exploreSimilar(request: ExploreSimilarRequest): Promise<GenerateImageResponse> {
    return this.#request('/v1/images/explore/similar', request, isGenerateImageResponse);
  }

  crispUpscale(request: CrispUpscaleRequest): Promise<ProcessImageResponse> {
    return this.#request('/v1/images/crispUpscale', request, isProcessImageResponse);
  }

  creativeUpscale(request: CreativeUpscaleRequest): Promise<ProcessImageResponse> {
    return this.#request('/v1/images/creativeUpscale', request, isProcessImageResponse);
  }

  listStyles(): Promise<ListStylesResponse> {
    return this.#requestWithoutBody('GET', '/v1/styles', isListStylesResponse);
  }

  listBasicStyles(): Promise<ListBasicStylesResponse> {
    return this.#requestWithoutBody('GET', '/v1/styles/basic', isListBasicStylesResponse);
  }

  getStyle(styleId: string): Promise<RecraftStyle> {
    return this.#requestWithoutBody(
      'GET',
      `/v1/styles/${encodeURIComponent(styleId)}`,
      isRecraftStyle,
    );
  }

  deleteStyle(styleId: string): Promise<DeleteStyleResponse> {
    return this.#requestWithoutBody(
      'DELETE',
      `/v1/styles/${encodeURIComponent(styleId)}`,
      isDeleteStyleResponse,
    );
  }

  async #request<T>(
    path: string,
    request: object,
    validates: (value: unknown) => value is T,
  ): Promise<T> {
    const multipart = 'mode' in request && request.mode === 'multipart';
    const billing = billingOf(request);
    const init: RequestInit = {
      method: 'POST',
      headers: multipart
        ? { Authorization: `Bearer ${this.#apiToken}` }
        : {
            Authorization: `Bearer ${this.#apiToken}`,
            'Content-Type': 'application/json',
          },
      body: multipart ? toFormData(request) : JSON.stringify(withoutClientFields(request)),
    };
    return this.#send(withBilling(path, billing), init, validates);
  }

  #requestWithoutBody<T>(
    method: 'GET' | 'DELETE',
    path: string,
    validates: (value: unknown) => value is T,
  ): Promise<T> {
    return this.#send(
      path,
      { method, headers: { Authorization: `Bearer ${this.#apiToken}` } },
      validates,
    );
  }

  async #send<T>(
    path: string,
    init: RequestInit,
    validates: (value: unknown) => value is T,
  ): Promise<T> {
    const response = await this.#transport(`${this.#baseUrl}${path}`, init);
    const rawBody = await response.text();
    const parsedBody = parseBody(rawBody);

    if (!response.ok) {
      throw new RecraftError(response.status, rawBody, parsedBody);
    }
    if (!validates(parsedBody)) {
      throw new RecraftError(
        response.status,
        rawBody,
        parsedBody,
        `Invalid ${schemaName(validates)} from Recraft`,
      );
    }
    return parsedBody;
  }
}

function billingOf(request: object): 'api' | 'subscription' | undefined {
  if (!('billing' in request)) return undefined;
  return request.billing === 'api' || request.billing === 'subscription'
    ? request.billing
    : undefined;
}

function withBilling(path: string, billing: 'api' | 'subscription' | undefined): string {
  return billing === undefined ? path : `${path}?billing=${billing}`;
}

function withoutClientFields(request: object): Record<string, unknown> {
  const entries = Object.entries(request).filter(
    ([key]) => key !== 'mode' && key !== 'billing',
  );
  return Object.fromEntries(entries);
}

function toFormData(request: object): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(request)) {
    if (key === 'mode' || key === 'billing' || value === undefined) continue;
    if (key === 'files' && Array.isArray(value)) {
      value.forEach((asset, index) => appendAsset(form, `file${index + 1}`, asAsset(asset)));
      continue;
    }
    if (isAsset(value)) {
      appendAsset(form, key, value);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.every(isScalar)) {
        value.forEach((item) => form.append(key, String(item)));
      } else {
        form.append(key, JSON.stringify(value));
      }
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      form.append(key, JSON.stringify(value));
      continue;
    }
    form.append(key, String(value));
  }
  return form;
}

function appendAsset(form: FormData, key: string, asset: RecraftBinaryAsset): void {
  const bytes = asset.bytes.slice().buffer as ArrayBuffer;
  form.append(key, new Blob([bytes], { type: asset.contentType }), asset.filename);
}

function isAsset(value: unknown): value is RecraftBinaryAsset {
  return (
    isRecord(value) &&
    value.bytes instanceof Uint8Array &&
    typeof value.filename === 'string' &&
    typeof value.contentType === 'string'
  );
}

function asAsset(value: unknown): RecraftBinaryAsset {
  if (!isAsset(value)) throw new TypeError('Invalid Recraft binary asset');
  return value;
}

function isScalar(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

function parseBody(rawBody: string): unknown {
  if (rawBody === '') return '';
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecraftImage(value: unknown): value is RecraftImage {
  return (
    isRecord(value) &&
    typeof value.image_id === 'string' &&
    optionalString(value.url) &&
    optionalString(value.b64_json) &&
    optionalString(value.revised_prompt) &&
    (value.features === undefined || isImageFeatures(value.features))
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isImageFeatures(value: unknown): boolean {
  return isRecord(value) && (value.nsfw_score === undefined || typeof value.nsfw_score === 'number');
}

function isGenerateImageResponse(value: unknown): value is GenerateImageResponse {
  return (
    isRecord(value) &&
    typeof value.created === 'number' &&
    typeof value.credits === 'number' &&
    Array.isArray(value.data) &&
    value.data.every(isRecraftImage)
  );
}

function isProcessImageResponse(value: unknown): value is ProcessImageResponse {
  return (
    isRecord(value) &&
    typeof value.created === 'number' &&
    typeof value.credits === 'number' &&
    isRecraftImage(value.image)
  );
}

function isCreateStyleResponse(value: unknown): value is CreateStyleResponse {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.style === 'string' &&
    optionalString(value.substyle) &&
    typeof value.creation_time === 'string' &&
    typeof value.is_private === 'boolean' &&
    typeof value.credits === 'number'
  );
}

function isRecraftStyle(value: unknown): value is RecraftStyle {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.style === 'string' &&
    (value.substyle === undefined || typeof value.substyle === 'string') &&
    typeof value.creation_time === 'string' &&
    typeof value.is_private === 'boolean'
  );
}

function isBasicStyle(value: unknown): value is BasicStyle {
  return (
    isRecord(value) &&
    typeof value.style_id === 'string' &&
    typeof value.style === 'string' &&
    typeof value.model === 'string' &&
    FIRST_PARTY_MODELS.has(value.model)
  );
}

function isListStylesResponse(value: unknown): value is ListStylesResponse {
  return isRecord(value) && Array.isArray(value.styles) && value.styles.every(isRecraftStyle);
}

function isListBasicStylesResponse(value: unknown): value is ListBasicStylesResponse {
  return isRecord(value) && Array.isArray(value.styles) && value.styles.every(isBasicStyle);
}

function isDeleteStyleResponse(value: unknown): value is DeleteStyleResponse {
  return isRecord(value);
}

function schemaName(validator: (value: unknown) => boolean): string {
  if (validator === isGenerateImageResponse) return 'GenerateImageResponse';
  if (validator === isProcessImageResponse) return 'ProcessImageResponse';
  if (validator === isListStylesResponse) return 'ListStylesResponse';
  if (validator === isListBasicStylesResponse) return 'ListBasicStylesResponse';
  if (validator === isRecraftStyle) return 'RecraftStyle';
  if (validator === isDeleteStyleResponse) return 'DeleteStyleResponse';
  return 'CreateStyleResponse';
}
