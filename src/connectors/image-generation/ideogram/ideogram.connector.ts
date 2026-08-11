import type {
  IdeogramAsyncGenerationAccepted,
  IdeogramEditWithPromptRequest,
  IdeogramGenerateTransparentV3Request,
  IdeogramGenerateV3Request,
  IdeogramGenerateV4Request,
  IdeogramGenerationStatus,
  IdeogramImageResponseV3,
  IdeogramImageResponseV4,
  IdeogramInpaintV3Request,
  IdeogramLayerizeTextResponse,
  IdeogramLayerizeTextV3Request,
  IdeogramReframeV3Request,
  IdeogramRemixV3Request,
  IdeogramRemixV4Request,
  IdeogramRemoveBackgroundRequest,
  IdeogramRemoveBackgroundResponse,
  IdeogramReplaceBackgroundV3Request,
  IdeogramTransport,
  IdeogramTransportRequest,
  IdeogramTransportResponse,
  IdeogramUpscaleRequest,
  IdeogramUpscaleResponse,
} from './ideogram.types';

const IDEOGRAM_ORIGIN = 'https://api.ideogram.ai';

export class IdeogramApiError extends Error {
  readonly name = 'IdeogramApiError';

  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`Ideogram API request failed with HTTP ${status} at ${path}`);
  }
}

export class FetchIdeogramTransport implements IdeogramTransport {
  async request<T = unknown>(
    request: IdeogramTransportRequest,
  ): Promise<IdeogramTransportResponse<T>> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: this.parseBody(text) as T,
    };
  }

  private parseBody(body: string): unknown {
    if (body.length === 0) return '';
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
}

export class IdeogramConnector {
  constructor(
    private readonly apiKey: string,
    private readonly transport: IdeogramTransport,
  ) {
    if (apiKey.trim().length === 0) {
      throw new Error('Ideogram API key is required');
    }
  }

  generateV4(request: IdeogramGenerateV4Request): Promise<IdeogramImageResponseV4> {
    return this.postForm('/v1/ideogram-v4/generate', request);
  }

  generateV4Async(
    request: IdeogramGenerateV4Request,
    webhookUrl: string,
  ): Promise<IdeogramAsyncGenerationAccepted> {
    const query = new URLSearchParams({ webhook_url: webhookUrl });
    return this.postForm(`/v1/ideogram-v4/async/generate?${query.toString()}`, request);
  }

  getGeneration(generationId: string): Promise<IdeogramGenerationStatus> {
    return this.send(`/v1/generations/${encodeURIComponent(generationId)}`, 'GET');
  }

  remixV4(request: IdeogramRemixV4Request): Promise<IdeogramImageResponseV4> {
    return this.postForm('/v1/ideogram-v4/remix', request);
  }

  generateV3(request: IdeogramGenerateV3Request): Promise<IdeogramImageResponseV3> {
    return this.postForm('/v1/ideogram-v3/generate', request);
  }

  generateTransparentV3(
    request: IdeogramGenerateTransparentV3Request,
  ): Promise<IdeogramImageResponseV3> {
    return this.postForm('/v1/ideogram-v3/generate-transparent', request);
  }

  inpaintV3(request: IdeogramInpaintV3Request): Promise<IdeogramImageResponseV3> {
    return this.postForm('/v1/ideogram-v3/inpaint', request);
  }

  remixV3(request: IdeogramRemixV3Request): Promise<IdeogramImageResponseV3> {
    return this.postForm('/v1/ideogram-v3/remix', request);
  }

  reframeV3(request: IdeogramReframeV3Request): Promise<IdeogramImageResponseV3> {
    return this.postForm('/v1/ideogram-v3/reframe', request);
  }

  replaceBackgroundV3(
    request: IdeogramReplaceBackgroundV3Request,
  ): Promise<IdeogramImageResponseV3> {
    return this.postForm('/v1/ideogram-v3/replace-background', request);
  }

  removeBackground(
    request: IdeogramRemoveBackgroundRequest,
  ): Promise<IdeogramRemoveBackgroundResponse> {
    return this.postForm('/v1/remove-background', request);
  }

  layerizeTextV3(request: IdeogramLayerizeTextV3Request): Promise<IdeogramLayerizeTextResponse> {
    return this.postForm('/v1/ideogram-v3/layerize-text', request);
  }

  editWithPrompt(request: IdeogramEditWithPromptRequest): Promise<IdeogramImageResponseV3> {
    return this.postForm('/v1/edit', request);
  }

  upscale(request: IdeogramUpscaleRequest): Promise<IdeogramUpscaleResponse> {
    return this.postForm('/upscale', request);
  }

  private postForm<T>(path: string, request: object): Promise<T> {
    return this.send(path, 'POST', this.toFormData(request));
  }

  private async send<T>(path: string, method: 'GET' | 'POST', body?: FormData): Promise<T> {
    const response = await this.transport.request<T>({
      method,
      url: `${IDEOGRAM_ORIGIN}${path}`,
      headers: { 'Api-Key': this.apiKey },
      body,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new IdeogramApiError(response.status, this.pathWithoutQuery(path), response.body);
    }
    return response.body;
  }

  private pathWithoutQuery(path: string): string {
    return path.split('?', 1)[0];
  }

  private toFormData(request: object): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(request)) {
      this.append(form, key, value);
    }
    return form;
  }

  private append(form: FormData, key: string, value: unknown): void {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      for (const member of value) this.append(form, key, member);
      return;
    }
    if (value instanceof Blob) {
      form.append(key, value);
      return;
    }
    if (value !== null && typeof value === 'object') {
      form.append(key, JSON.stringify(value));
      return;
    }
    form.append(key, value === null ? 'null' : String(value));
  }
}

export type * from './ideogram.types';
