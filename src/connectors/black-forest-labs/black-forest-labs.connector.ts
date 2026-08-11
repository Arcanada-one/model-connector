export const BFL_BASE_URLS = {
  global: 'https://api.bfl.ai/v1',
  eu: 'https://api.eu.bfl.ai/v1',
  us: 'https://api.us.bfl.ai/v1',
} as const;

export type BflBaseUrl = (typeof BFL_BASE_URLS)[keyof typeof BFL_BASE_URLS];

export const BFL_FLUX_OPERATIONS = {
  flux2Flex: '/flux-2-flex',
  flux2Klein4b: '/flux-2-klein-4b',
  flux2Klein9b: '/flux-2-klein-9b',
  flux2Klein9bPreview: '/flux-2-klein-9b-preview',
  flux2Max: '/flux-2-max',
  flux2Pro: '/flux-2-pro',
  flux2ProPreview: '/flux-2-pro-preview',
  fluxDev: '/flux-dev',
  fluxPro: '/flux-pro',
  fluxPro11: '/flux-pro-1.1',
  fluxPro11Ultra: '/flux-pro-1.1-ultra',
  kontextMax: '/flux-kontext-max',
  kontextPro: '/flux-kontext-pro',
  fill: '/flux-pro-1.0-fill',
  expand: '/flux-pro-1.0-expand',
} as const;

export interface BflTransportRequest {
  method: 'POST' | 'GET';
  url: string;
  headers: Record<string, string>;
  body?: object;
}

export interface BflTransport {
  request<T>(request: BflTransportRequest): Promise<T>;
}

type Operation = keyof typeof BFL_FLUX_OPERATIONS;

export class BlackForestLabsConnector {
  constructor(
    private readonly apiKey: string,
    private readonly transport: BflTransport,
    private readonly baseUrl: BflBaseUrl = BFL_BASE_URLS.global,
  ) {}

  flux2Flex<T>(body: object): Promise<T> {
    return this.create('flux2Flex', body);
  }

  flux2Klein4b<T>(body: object): Promise<T> {
    return this.create('flux2Klein4b', body);
  }

  flux2Klein9b<T>(body: object): Promise<T> {
    return this.create('flux2Klein9b', body);
  }

  flux2Klein9bPreview<T>(body: object): Promise<T> {
    return this.create('flux2Klein9bPreview', body);
  }

  flux2Max<T>(body: object): Promise<T> {
    return this.create('flux2Max', body);
  }

  flux2Pro<T>(body: object): Promise<T> {
    return this.create('flux2Pro', body);
  }

  flux2ProPreview<T>(body: object): Promise<T> {
    return this.create('flux2ProPreview', body);
  }

  fluxDev<T>(body: object): Promise<T> {
    return this.create('fluxDev', body);
  }

  fluxPro<T>(body: object): Promise<T> {
    return this.create('fluxPro', body);
  }

  fluxPro11<T>(body: object): Promise<T> {
    return this.create('fluxPro11', body);
  }

  fluxPro11Ultra<T>(body: object): Promise<T> {
    return this.create('fluxPro11Ultra', body);
  }

  kontextMax<T>(body: object): Promise<T> {
    return this.create('kontextMax', body);
  }

  kontextPro<T>(body: object): Promise<T> {
    return this.create('kontextPro', body);
  }

  fill<T>(body: object): Promise<T> {
    return this.create('fill', body);
  }

  expand<T>(body: object): Promise<T> {
    return this.create('expand', body);
  }

  async getResult<T>(pollingUrl: string): Promise<T> {
    this.requireApiKey();

    return this.transport.request<T>({
      method: 'GET',
      url: pollingUrl,
      headers: { 'x-key': this.apiKey },
    });
  }

  private async create<T>(operation: Operation, body: object): Promise<T> {
    this.requireApiKey();

    return this.transport.request<T>({
      method: 'POST',
      url: `${this.baseUrl}${BFL_FLUX_OPERATIONS[operation]}`,
      headers: {
        'Content-Type': 'application/json',
        'x-key': this.apiKey,
      },
      body,
    });
  }

  private requireApiKey(): void {
    if (this.apiKey.length === 0) {
      throw new Error('Black Forest Labs API key is required');
    }
  }
}
