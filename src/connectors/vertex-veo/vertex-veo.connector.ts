export const VERTEX_VEO_MODELS = [
  'veo-2.0-generate-001',
  'veo-3.0-generate-001',
  'veo-3.0-fast-generate-001',
  'veo-3.1-generate-001',
  'veo-3.1-fast-generate-001',
] as const;

export interface VeoTransport {
  post<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T>;
}

export interface VertexVeoConfig {
  project: string;
  location: string;
}

export interface VeoPredictRequest {
  instances: Array<Record<string, unknown>>;
  parameters: Record<string, unknown> & { sampleCount?: number; storageUri?: string };
}

export interface VeoOperation {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string; details?: unknown[] };
  response?: Record<string, unknown>;
  [key: string]: unknown;
}

export class VertexVeoConnector {
  constructor(
    private readonly config: VertexVeoConfig,
    private readonly transport: VeoTransport,
  ) {
    if (!config.project || !config.location)
      throw new Error('Vertex Veo project and location are required');
  }

  async predictLongRunning(
    model: string,
    request: VeoPredictRequest,
    bearerToken: string,
  ): Promise<VeoOperation> {
    this.validate(model, request, bearerToken);
    return this.transport.post<VeoOperation>(
      this.url(model, 'predictLongRunning'),
      request,
      this.headers(bearerToken),
    );
  }

  async fetchPredictOperation(
    model: string,
    operationName: string,
    bearerToken: string,
  ): Promise<VeoOperation> {
    this.validateModel(model);
    if (!operationName) throw new Error('Vertex Veo operationName is required');
    if (!bearerToken) throw new Error('Vertex Veo OAuth bearer token is required');
    return this.transport.post<VeoOperation>(
      this.url(model, 'fetchPredictOperation'),
      { operationName },
      this.headers(bearerToken),
    );
  }

  private validate(model: string, request: VeoPredictRequest, token: string): void {
    this.validateModel(model);
    if (!token) throw new Error('Vertex Veo OAuth bearer token is required');
    if (
      !request ||
      !Array.isArray(request.instances) ||
      request.instances.length === 0 ||
      !request.parameters
    )
      throw new Error('Vertex Veo request requires instances and parameters');
    const count = request.parameters.sampleCount;
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 4))
      throw new Error('Vertex Veo sampleCount must be an integer from 1 through 4');
    const uri = request.parameters.storageUri;
    if (uri !== undefined && !uri.startsWith('gs://'))
      throw new Error('Vertex Veo storageUri must use gs://');
  }

  private validateModel(model: string): void {
    if (!(VERTEX_VEO_MODELS as readonly string[]).includes(model))
      throw new Error(`Unsupported Veo model: ${model}`);
  }

  private url(model: string, method: 'predictLongRunning' | 'fetchPredictOperation'): string {
    const { project, location } = this.config;
    return `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${model}:${method}`;
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
}
