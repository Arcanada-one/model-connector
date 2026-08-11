export const KLING_INTERNATIONAL_BASE_URL = 'https://api-singapore.klingai.com';

export interface KlingJwtSigner {
  sign(
    payload: { iss: string; exp: number; nbf: number },
    header: { alg: 'HS256'; typ: 'JWT' },
  ): string;
}

export interface KlingHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: { Authorization: string; 'Content-Type': 'application/json' };
  body?: unknown;
}

export interface KlingHttpResponse {
  status: number;
  body: unknown;
}

export interface KlingHttpTransport {
  request(request: KlingHttpRequest): Promise<KlingHttpResponse>;
}

export interface KlingEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

export type KlingConnectorResponse<T = unknown> = KlingEnvelope<T> & { status: number };

type VideoFamily = 'text2video' | 'image2video' | 'multi-image2video';

export class KlingInternationalConnector {
  constructor(
    private readonly transport: KlingHttpTransport,
    private readonly signer: KlingJwtSigner,
    private readonly accessKey: string,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  createTextToVideo(body: Record<string, unknown>) {
    return this.create('text2video', body);
  }

  queryTextToVideo(taskId: string) {
    return this.query('text2video', taskId);
  }

  createImageToVideo(body: Record<string, unknown>) {
    return this.create('image2video', body);
  }

  queryImageToVideo(taskId: string) {
    return this.query('image2video', taskId);
  }

  createMultiImageToVideo(body: Record<string, unknown>) {
    return this.create('multi-image2video', body);
  }

  queryMultiImageToVideo(taskId: string) {
    return this.query('multi-image2video', taskId);
  }

  private create(family: VideoFamily, body: Record<string, unknown>) {
    return this.send('POST', `/v1/videos/${family}`, body);
  }

  private query(family: VideoFamily, taskId: string) {
    return this.send('GET', `/v1/videos/${family}/${encodeURIComponent(taskId)}`);
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<KlingConnectorResponse> {
    const now = this.nowSeconds();
    const token = this.signer.sign(
      { iss: this.accessKey, exp: now + 1800, nbf: now - 5 },
      { alg: 'HS256', typ: 'JWT' },
    );
    const response = await this.transport.request({
      method,
      url: `${KLING_INTERNATIONAL_BASE_URL}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body }),
    });
    const envelope = response.body as KlingEnvelope;
    return { status: response.status, ...envelope };
  }
}
