import { Injectable, Logger, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  TranscribatorProxy,
  ProxyResult,
  SpeechEndpoint,
  UpstreamTimeoutError,
  UpstreamUnavailableError,
  UpstreamNetworkError,
} from './transcribator.proxy';
import { isDeepgramTtsRequest, TtsRequestDto } from './dto/tts-request.dto';
import { VadRequestDto } from './dto/vad-request.dto';
import { SpeechErrorEnvelope } from './dto/speech-response.dto';
import { DeepgramTtsConnector, DeepgramTtsError } from './tts/deepgram-tts.connector';
import type { DeepgramAuraModelId } from './tts/deepgram-aura-models';
import { isTogetherTtsRequest, type TogetherTtsRequestDto } from './dto/tts-request.dto';
import { TogetherTtsConnector, TogetherTtsError } from './tts/together-tts.connector';
// CONN-1671 — per-key access policy. The named TTS connectors (deepgram,
// together) dispatch directly, bypassing the ConnectorsService choke point, so
// the provider/model gate is applied inline (same class of bypass as STT). The
// VAD path and the TTS Transcribator proxy target the self-hosted backend (no
// third-party paid connector, no provider identity in the policy vocabulary)
// and are intentionally left ungated.
import {
  InvalidStoredPolicyError,
  PolicyService,
  type PolicyServiceLike,
} from '../policy/policy.service';
import type { ApiKeyPolicy } from '../policy/policy.schema';

export type ProxyOutcome =
  | { kind: 'proxied'; result: ProxyResult }
  | { kind: 'error'; envelope: SpeechErrorEnvelope };

@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);

  constructor(
    private readonly proxy: TranscribatorProxy,
    private readonly deepgramTts: DeepgramTtsConnector,
    private readonly togetherTts: TogetherTtsConnector,
    // CONN-1671 — permissive no-op default (null policy = legacy unrestricted)
    // so existing manual `new SpeechService(...)` constructions keep working;
    // the module provides the real PolicyService.
    @Inject(PolicyService)
    private readonly policyService: PolicyServiceLike = {
      getPolicyForKey: async () => null,
      isProviderAllowed: () => true,
      isModelAllowed: () => ({ allowed: true }),
      getTier: async () => undefined,
      resolveProviderKeyEnv: () => null,
      invalidateKey: () => undefined,
    },
  ) {}

  async tts(body: TtsRequestDto, requestId?: string, apiKeyId?: string): Promise<ProxyOutcome> {
    if (isDeepgramTtsRequest(body)) {
      const deny = await this.policyDenyEnvelope(apiKeyId, 'deepgram', body.model);
      if (deny) return deny;
      return this.deepgramTtsOrError(body.model, body.text, requestId);
    }
    if (isTogetherTtsRequest(body)) {
      const deny = await this.policyDenyEnvelope(apiKeyId, 'together', body.model);
      if (deny) return deny;
      return this.togetherTtsOrError(body, requestId);
    }
    // Transcribator self-hosted proxy — not a third-party paid connector; ungated.
    return this.proxyOrError('tts', body as unknown as Record<string, unknown>, requestId);
  }

  /**
   * CONN-1671 — evaluate the caller's per-key policy for a named TTS provider.
   * Returns a 403 error outcome when the policy denies the (provider, model),
   * or null to proceed. Null apiKeyId / null stored policy = legacy unrestricted
   * (returns null → dispatch unchanged). A malformed stored policy fails CLOSED.
   */
  private async policyDenyEnvelope(
    apiKeyId: string | undefined,
    provider: string,
    model: string | undefined,
  ): Promise<ProxyOutcome | null> {
    if (!apiKeyId) return null;
    let policy: ApiKeyPolicy | null;
    try {
      policy = await this.policyService.getPolicyForKey(apiKeyId);
    } catch (err) {
      if (err instanceof InvalidStoredPolicyError) {
        this.logger.error(
          `TTS access policy for key ${apiKeyId} is invalid — failing closed (request denied)`,
        );
        return {
          kind: 'error',
          envelope: {
            statusCode: 403,
            error_code: 'stt_policy_config_error',
            message:
              'Access policy for this API key could not be evaluated; request denied (fail-closed).',
          },
        };
      }
      throw err;
    }
    if (!policy) return null;

    if (!this.policyService.isProviderAllowed(policy, provider)) {
      return this.ttsPolicyViolation(provider, model);
    }
    if (
      typeof model === 'string' &&
      model.length > 0 &&
      policy.models &&
      policy.models.mode !== 'all'
    ) {
      const tier =
        policy.models.mode === 'free-only'
          ? await this.policyService.getTier(provider, model)
          : undefined;
      if (!this.policyService.isModelAllowed(policy, provider, model, tier).allowed) {
        return this.ttsPolicyViolation(provider, model);
      }
    }
    return null;
  }

  private ttsPolicyViolation(provider: string, model: string | undefined): ProxyOutcome {
    this.logger.warn(
      `TTS request blocked by API key policy — provider '${provider}'${
        model ? ` model '${model}'` : ''
      } denied`,
    );
    return {
      kind: 'error',
      envelope: {
        statusCode: 403,
        error_code: 'tts_policy_violation',
        message: `TTS provider '${provider}' is not permitted by this API key's access policy.`,
      },
    };
  }

  async vad(body: VadRequestDto, requestId?: string): Promise<ProxyOutcome> {
    return this.proxyOrError('vad', body as unknown as Record<string, unknown>, requestId);
  }

  private async proxyOrError(
    endpoint: SpeechEndpoint,
    body: Record<string, unknown>,
    requestId?: string,
  ): Promise<ProxyOutcome> {
    const id = requestId ?? randomUUID();
    try {
      const result = await this.proxy.proxy(endpoint, body, { requestId: id });
      return { kind: 'proxied', result };
    } catch (err) {
      const envelope = this.mapErrorToEnvelope(err);
      this.logger.warn(
        `speech ${endpoint} proxy error: ${envelope.error_code} (${envelope.message})`,
      );
      return { kind: 'error', envelope };
    }
  }

  private async deepgramTtsOrError(
    model: DeepgramAuraModelId,
    text: string,
    requestId?: string,
  ): Promise<ProxyOutcome> {
    const id = requestId ?? randomUUID();
    try {
      const result = await this.deepgramTts.synthesize(model, text, { requestId: id });
      return { kind: 'proxied', result };
    } catch (error) {
      const envelope = this.mapDeepgramErrorToEnvelope(error);
      const upstreamStatus =
        error instanceof DeepgramTtsError && error.upstreamStatus !== undefined
          ? String(error.upstreamStatus)
          : 'none';
      this.logger.warn(
        `speech tts provider error: request_id=${id} code=${envelope.error_code} upstream_status=${upstreamStatus}`,
      );
      return { kind: 'error', envelope };
    }
  }

  private mapDeepgramErrorToEnvelope(error: unknown): SpeechErrorEnvelope {
    if (error instanceof DeepgramTtsError) {
      return {
        statusCode: error.statusCode,
        error_code: error.errorCode,
        message: error.message,
      };
    }
    return {
      statusCode: 502,
      error_code: 'upstream_unavailable',
      message: 'Deepgram TTS provider is unavailable.',
    };
  }

  private async togetherTtsOrError(
    request: TogetherTtsRequestDto,
    requestId?: string,
  ): Promise<ProxyOutcome> {
    const id = requestId ?? randomUUID();
    try {
      const result = await this.togetherTts.synthesize(request, { requestId: id });
      return { kind: 'proxied', result };
    } catch (error) {
      const envelope = this.mapTogetherErrorToEnvelope(error);
      const upstreamStatus =
        error instanceof TogetherTtsError && error.upstreamStatus !== undefined
          ? String(error.upstreamStatus)
          : 'none';
      this.logger.warn(
        `speech tts provider error: request_id=${id} code=${envelope.error_code} upstream_status=${upstreamStatus}`,
      );
      return { kind: 'error', envelope };
    }
  }

  private mapTogetherErrorToEnvelope(error: unknown): SpeechErrorEnvelope {
    if (error instanceof TogetherTtsError) {
      return {
        statusCode: error.statusCode,
        error_code: error.errorCode,
        message: error.message,
      };
    }
    return {
      statusCode: 502,
      error_code: 'upstream_unavailable',
      message: 'Together TTS provider is unavailable.',
    };
  }

  private mapErrorToEnvelope(err: unknown): SpeechErrorEnvelope {
    if (err instanceof UpstreamTimeoutError) {
      return {
        statusCode: err.statusCode,
        error_code: err.errorCode,
        message: err.message,
        upstream_url: err.upstreamUrl,
      };
    }
    if (err instanceof UpstreamUnavailableError || err instanceof UpstreamNetworkError) {
      return {
        statusCode: err.statusCode,
        error_code: err.errorCode,
        message: err.message,
        upstream_url: err.upstreamUrl,
      };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    return {
      statusCode: 502,
      error_code: 'upstream_unavailable',
      message: `Speech proxy unexpected failure: ${message}`,
    };
  }
}
