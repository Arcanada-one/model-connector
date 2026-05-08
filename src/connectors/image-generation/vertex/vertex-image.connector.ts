import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { BaseImageConnector } from '../base-image.connector';
import { VertexAuthService } from './vertex-auth.service';
import type { ImageGenerationRequest, ImageGenerationResult, ProviderId } from '../types';
import { calculateCostUsd } from '../pricing';
import { isPlaceholder } from '../errors/is-placeholder';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

const VAULT_PATH = 'arcanada/prod/env/model-connector-vertex';

/**
 * Maps our internal model IDs to Vertex AI endpoint model identifiers.
 * Source: CONN-0052 plan §5.5.
 */
const VERTEX_MODEL_MAP: Record<string, string> = {
  'vertex:nano-banana': 'imagen-nano',
  'vertex:imagen-4-fast': 'imagen-4-fast',
  'vertex:imagen-4': 'imagen-4',
  'vertex:imagen-4-ultra': 'imagen-4-ultra',
};

const DEFAULT_MODEL = 'vertex:imagen-4-fast';

/**
 * Vertex AI Imagen connector (Imagen 4 family + Nano Banana).
 * Uses google-auth-library for service-account JWT → access token.
 */
export class VertexImageConnector extends BaseImageConnector {
  private readonly authService: VertexAuthService;
  private readonly serviceAccountJson: string | undefined;

  constructor(
    projectId: string,
    location: string,
    serviceAccountJson: string | undefined,
    cbManager: CircuitBreakerManager,
  ) {
    super(cbManager);
    this.serviceAccountJson = serviceAccountJson;
    this.authService = new VertexAuthService(projectId, location, serviceAccountJson);
  }

  async generate(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    // Placeholder detection: check private_key field in SA JSON
    if (this.serviceAccountJson) {
      try {
        const sa = JSON.parse(this.serviceAccountJson) as Record<string, string>;
        if (isPlaceholder(sa.private_key ?? '')) {
          throw new ProviderNotProvisionedError('vertex', VAULT_PATH);
        }
      } catch (e) {
        if (e instanceof ProviderNotProvisionedError) throw e;
        // Malformed JSON = treat as unprovisioned
        throw new ProviderNotProvisionedError('vertex', VAULT_PATH);
      }
    } else {
      throw new ProviderNotProvisionedError('vertex', VAULT_PATH);
    }

    const modelId = req.model ?? DEFAULT_MODEL;
    const vertexModel = VERTEX_MODEL_MAP[modelId] ?? 'imagen-4-fast';
    const startMs = Date.now();

    return this.withCircuit(modelId, async () => {
      const token = await this.authService.getAccessToken();
      const project = this.authService.projectIdValue;
      const location = this.authService.locationValue;

      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${vertexModel}:predict`;

      const body = {
        instances: [
          {
            prompt: req.prompt,
            ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
          },
        ],
        parameters: {
          sampleCount: req.count ?? 1,
          aspectRatio: req.aspectRatio ?? '1:1',
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // 403 BILLING_DISABLED or PERMISSION_DENIED → treat as ProviderNotProvisionedError
        // so the router fallback loop can skip vertex and try next provider.
        if (response.status === 403) {
          throw new ProviderNotProvisionedError('vertex', VAULT_PATH);
        }
        throw new Error(`Vertex AI API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        predictions: Array<{ bytesBase64Encoded: string; mimeType: string }>;
      };

      if (!data.predictions?.length) {
        throw new Error('Vertex AI returned empty predictions');
      }

      const latencyMs = Date.now() - startMs;
      const count = req.count ?? 1;
      const costUsd = calculateCostUsd(modelId, count);

      // In Phase 2 we will upload to R2 and return presigned URLs.
      // For now return inline base64 data URIs.
      const urls = data.predictions.map((p) => `data:${p.mimeType};base64,${p.bytesBase64Encoded}`);

      return {
        requestId: crypto.randomUUID(),
        status: 'completed',
        urls,
        costUsd,
        latencyMs,
        routing: {
          chosenProvider: 'vertex' as ProviderId,
          chosenModel: modelId,
          fallbackUsed: false,
          reason: `vertex model ${vertexModel}`,
          candidate: { modelId, providerId: 'vertex' as ProviderId, tier: req.tier },
          costUsd,
        },
      };
    });
  }
}
