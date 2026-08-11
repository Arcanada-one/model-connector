export type AdobeFireflyOperation =
  | 'generate'
  | 'generateImage5'
  | 'similar'
  | 'expand'
  | 'fill'
  | 'composite'
  | 'preciseComposite'
  | 'adaptiveComposite'
  | 'upscale';

export type AdobeFireflyModel =
  | 'image3'
  | 'image3_custom'
  | 'image4_standard'
  | 'image4_ultra'
  | 'image4_custom'
  | 'image5'
  | 'precise_upsampler_v1';

export type AdobeFireflyJobStatus = 'running' | 'succeeded' | 'failed';
export type AdobeFireflyMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/tiff'
  | 'image/jxl';
export type AdobeFireflyTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AdobeFireflyUrlSubmission {
  jobId: string;
  statusUrl: string;
  cancelUrl: string;
  status?: 'running';
}

export interface AdobeFireflyLinkSubmission {
  links: {
    result: { href: string };
    cancel: { href: string };
  };
  progress?: number;
}

export type AdobeFireflySubmission = AdobeFireflyUrlSubmission | AdobeFireflyLinkSubmission;

export interface AdobeFireflyJob {
  jobId: string;
  status: AdobeFireflyJobStatus;
  result?: unknown;
}

export interface AdobeFireflyUpload {
  images: Array<{ id: string }>;
}

interface OperationDefinition {
  path: string;
  models: readonly AdobeFireflyModel[] | null;
  requiredModel?: AdobeFireflyModel;
}

const BASE_URL = 'https://firefly-api.adobe.io';
const V3_GENERATE_MODELS = [
  'image3',
  'image3_custom',
  'image4_standard',
  'image4_ultra',
  'image4_custom',
] as const;
const V3_SIMILAR_MODELS = ['image3', 'image4_standard', 'image4_ultra'] as const;

const OPERATION_DEFINITIONS: Record<AdobeFireflyOperation, OperationDefinition> = {
  generate: {
    path: '/v3/images/generate-async',
    models: V3_GENERATE_MODELS,
  },
  generateImage5: {
    path: '/v4/images/generate-async',
    models: ['image5'],
    requiredModel: 'image5',
  },
  similar: {
    path: '/v3/images/generate-similar-async',
    models: V3_SIMILAR_MODELS,
  },
  expand: {
    path: '/v3/images/expand-async',
    models: null,
  },
  fill: {
    path: '/v3/images/fill-async',
    models: null,
  },
  composite: {
    path: '/v3/images/generate-object-composite-async',
    models: null,
  },
  preciseComposite: {
    path: '/v3/images/precise-composite',
    models: null,
  },
  adaptiveComposite: {
    path: '/v3/images/adaptive-composite',
    models: null,
  },
  upscale: {
    path: '/v3/images/upscale',
    models: ['precise_upsampler_v1'],
    requiredModel: 'precise_upsampler_v1',
  },
};

export class AdobeFireflyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AdobeFireflyError';
  }
}

/**
 * Source-bounded client for Adobe's native Firefly image REST operations.
 * A Fetch-compatible transport is injected so tests never require network or credentials.
 */
export class AdobeFireflyConnector {
  constructor(
    private readonly clientId: string,
    private readonly accessToken: string,
    private readonly transport: AdobeFireflyTransport = fetch,
  ) {}

  async submit(
    operation: AdobeFireflyOperation,
    body: Readonly<Record<string, unknown>>,
    model?: AdobeFireflyModel,
  ): Promise<AdobeFireflySubmission> {
    const definition = OPERATION_DEFINITIONS[operation];
    const selectedModel = this.resolveModel(operation, definition, model);
    const headers = this.headers('application/json');
    if (selectedModel) {
      headers['x-model-version'] = selectedModel;
    }

    return await this.request<AdobeFireflySubmission>(`${BASE_URL}${definition.path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  getStatus(jobId: string): Promise<AdobeFireflyJob> {
    return this.request<AdobeFireflyJob>(`${BASE_URL}/v3/status/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  cancel(jobId: string): Promise<unknown> {
    return this.request<unknown>(`${BASE_URL}/v3/cancel/${encodeURIComponent(jobId)}`, {
      method: 'PUT',
      headers: this.headers(),
    });
  }

  uploadImage(bytes: Uint8Array, mediaType: AdobeFireflyMediaType): Promise<AdobeFireflyUpload> {
    return this.request<AdobeFireflyUpload>(`${BASE_URL}/v2/storage/image`, {
      method: 'POST',
      headers: this.headers(mediaType),
      body: bytes as unknown as BodyInit,
    });
  }

  private resolveModel(
    operation: AdobeFireflyOperation,
    definition: OperationDefinition,
    requestedModel?: AdobeFireflyModel,
  ): AdobeFireflyModel | undefined {
    if (definition.models === null) {
      if (requestedModel) {
        throw new TypeError(`Adobe Firefly ${operation} does not document a model header`);
      }
      return undefined;
    }

    const selectedModel = requestedModel ?? definition.requiredModel;
    if (selectedModel && !definition.models.includes(selectedModel)) {
      throw new TypeError(`Adobe Firefly model ${selectedModel} is not supported for ${operation}`);
    }
    return selectedModel;
  }

  private headers(contentType?: string): Record<string, string> {
    this.assertProvisioned();
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
      'x-api-key': this.clientId,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    };
  }

  private assertProvisioned(): void {
    if (!this.clientId.trim() || !this.accessToken.trim()) {
      throw new AdobeFireflyError('Adobe Firefly is not provisioned', 401, 'not_provisioned');
    }
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.transport(url, init);
    const text = await response.text();
    let payload: unknown;

    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        if (response.ok) {
          return undefined as T;
        }
      }
    }

    if (!response.ok) {
      const errorPayload = this.asErrorPayload(payload);
      const providerMessage = errorPayload.message ?? 'request failed';
      throw new AdobeFireflyError(
        `Adobe Firefly API error ${response.status}: ${this.redact(providerMessage)}`,
        response.status,
        errorPayload.error_code,
      );
    }

    return payload as T;
  }

  private asErrorPayload(payload: unknown): { error_code?: string; message?: string } {
    if (!payload || typeof payload !== 'object') {
      return {};
    }
    const candidate = payload as Record<string, unknown>;
    return {
      error_code: typeof candidate.error_code === 'string' ? candidate.error_code : undefined,
      message: typeof candidate.message === 'string' ? candidate.message : undefined,
    };
  }

  private redact(message: string): string {
    return message
      .split(this.clientId)
      .join('[redacted]')
      .split(this.accessToken)
      .join('[redacted]');
  }
}

export const ADOBE_FIREFLY_NATIVE_API = {
  baseUrl: BASE_URL,
  operations: Object.fromEntries(
    Object.entries(OPERATION_DEFINITIONS).map(([operation, definition]) => [
      operation,
      definition.path,
    ]),
  ) as Record<AdobeFireflyOperation, string>,
  models: {
    generate: V3_GENERATE_MODELS,
    similar: V3_SIMILAR_MODELS,
    generateImage5: ['image5'],
    upscale: ['precise_upsampler_v1'],
  },
  jobStatuses: ['running', 'succeeded', 'failed'],
  upload: {
    path: '/v2/storage/image',
    mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/jxl'],
    maxMegabytes: 15,
    validityDays: 7,
  },
  synchronousOperations: null,
  pagination: null,
  regionSelection: null,
} as const;
