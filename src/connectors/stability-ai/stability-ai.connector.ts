export const STABILITY_AI_BASE_URL = 'https://api.stability.ai';

export const STABILITY_AI_IMAGE_OPERATIONS = {
  generateCore: '/v2beta/stable-image/generate/core',
  generateUltra: '/v2beta/stable-image/generate/ultra',
  generateSd3: '/v2beta/stable-image/generate/sd3',
  editInpaint: '/v2beta/stable-image/edit/inpaint',
  editOutpaint: '/v2beta/stable-image/edit/outpaint',
  editErase: '/v2beta/stable-image/edit/erase',
  editSearchAndReplace: '/v2beta/stable-image/edit/search-and-replace',
  editSearchAndRecolor: '/v2beta/stable-image/edit/search-and-recolor',
  editRemoveBackground: '/v2beta/stable-image/edit/remove-background',
  editReplaceBackgroundAndRelight: '/v2beta/stable-image/edit/replace-background-and-relight',
} as const;

export type StabilityAiAccept = 'image/*' | 'application/json';

export interface StabilityAiTransportRequest {
  method: 'POST';
  url: string;
  headers: {
    Authorization: string;
    Accept: StabilityAiAccept;
  };
  body: FormData;
}

export interface StabilityAiTransport {
  request<T>(request: StabilityAiTransportRequest): Promise<T>;
}

type Operation = keyof typeof STABILITY_AI_IMAGE_OPERATIONS;

export class StabilityAiConnector {
  constructor(
    private readonly bearerToken: string,
    private readonly transport: StabilityAiTransport,
  ) {}

  generateCore<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('generateCore', body, accept);
  }

  generateUltra<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('generateUltra', body, accept);
  }

  generateSd3<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('generateSd3', body, accept);
  }

  editInpaint<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('editInpaint', body, accept);
  }

  editOutpaint<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('editOutpaint', body, accept);
  }

  editErase<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('editErase', body, accept);
  }

  editSearchAndReplace<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('editSearchAndReplace', body, accept);
  }

  editSearchAndRecolor<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('editSearchAndRecolor', body, accept);
  }

  editRemoveBackground<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('editRemoveBackground', body, accept);
  }

  editReplaceBackgroundAndRelight<T>(body: FormData, accept: StabilityAiAccept): Promise<T> {
    return this.execute('editReplaceBackgroundAndRelight', body, accept);
  }

  private async execute<T>(
    operation: Operation,
    body: FormData,
    accept: StabilityAiAccept,
  ): Promise<T> {
    if (this.bearerToken.length === 0) {
      throw new Error('Stability AI bearer token is required');
    }

    return this.transport.request<T>({
      method: 'POST',
      url: `${STABILITY_AI_BASE_URL}${STABILITY_AI_IMAGE_OPERATIONS[operation]}`,
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        Accept: accept,
      },
      body,
    });
  }
}
