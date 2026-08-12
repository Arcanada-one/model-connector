// CONN-1671 — per-key access-policy enforcement on the STT routing surface.
//
// SttRouterService.transcribe() dispatches to connectors DIRECTLY (it never
// passes through ConnectorsService.execute(), the CONN-1665 choke point), so a
// scoped API key could route paid STT bypassing its policy. These tests pin
// the gate: provider deny → skip + failover; all-denied → policy_violation
// (403); null policy → dispatch unchanged (the legacy-unrestricted contract).
//
// Mutation target: deleting the provider gate makes the "all candidates denied"
// case fall through to a normal dispatch instead of throwing
// SttPolicyViolationError.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SttRouterService } from './stt-router.service';
import { SttPolicyViolationError, SttPolicyConfigError } from './stt-pilot.errors';
import { validateEnv } from '../../config/env.schema';
import { InvalidStoredPolicyError, type PolicyServiceLike } from '../../policy/policy.service';
import type { ApiKeyPolicy } from '../../policy/policy.schema';
import type {
  ISttConnector,
  SttConnectorRequest,
  SttConnectorResult,
} from './interfaces/stt-connector.interface';

class FakeConnector implements ISttConnector {
  constructor(
    readonly name: string,
    readonly provider: string,
  ) {}
  transcribe = vi.fn<(req: SttConnectorRequest) => Promise<SttConnectorResult>>();
  getStatus = vi.fn();
}

const okResult: SttConnectorResult = {
  transcription: 'ok',
  audioDurationSeconds: 1,
  detectedLanguage: 'en',
  model: 'whisper-large-v3',
  costUsd: 0.00003,
  latencyMs: 100,
  providerRequestId: 'req_ok',
};

function buildRouter(opts: {
  policy?: ApiKeyPolicy | null;
  getPolicyForKey?: PolicyServiceLike['getPolicyForKey'];
  getTier?: PolicyServiceLike['getTier'];
}) {
  const fakeGroq = new FakeConnector('groq-stt', 'groq');
  const fakeDeepgram = new FakeConnector('deepgram-stt', 'deepgram');
  const fakeAssemblyAi = new FakeConnector('assemblyai-stt', 'assemblyai');
  const fakeOpenAi = new FakeConnector('openai-stt', 'openai');
  const fakeLocalWhisper = new FakeConnector('local-whisper', 'local-whisper');
  fakeGroq.transcribe.mockResolvedValue(okResult);

  const prisma = {
    sttTranscription: {
      create: vi.fn().mockResolvedValue(undefined),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: 0 } }),
    },
  };
  const metrics = { recordStt: vi.fn(), incrementSttSchemaFail: vi.fn() };

  const policyService: PolicyServiceLike = {
    getPolicyForKey: opts.getPolicyForKey ?? vi.fn().mockResolvedValue(opts.policy ?? null),
    // Delegate provider/model gates to the REAL evaluation semantics so the
    // spec exercises the router's wiring, not a bespoke fake decision.
    isProviderAllowed: (policy, provider) =>
      !policy?.providers || policy.providers.includes(provider),
    isModelAllowed: (policy, provider, modelId, tier) => {
      const models = policy?.models;
      if (!models || models.mode === 'all') return { allowed: true };
      if (models.mode === 'list') {
        return (models.list ?? []).includes(modelId)
          ? { allowed: true }
          : { allowed: false, reason: 'not in list' };
      }
      return tier === 'free' ? { allowed: true } : { allowed: false, reason: 'not free' };
    },
    getTier: opts.getTier ?? vi.fn().mockResolvedValue(undefined),
    resolveProviderKeyEnv: () => null,
    invalidateKey: () => undefined,
  };

  const router = new SttRouterService(
    fakeGroq as never,
    fakeDeepgram as never,
    fakeAssemblyAi as never,
    fakeOpenAi as never,
    fakeLocalWhisper as never,
    prisma as never,
    metrics as never,
    policyService,
  );
  router.setRegistry(
    new Map<string, ISttConnector>([
      ['groq', fakeGroq],
      ['deepgram', fakeDeepgram],
      ['assemblyai', fakeAssemblyAi],
      ['openai', fakeOpenAi],
      ['local-whisper', fakeLocalWhisper],
    ]),
  );
  return { router, fakeGroq, fakeDeepgram, fakeLocalWhisper, prisma, metrics, policyService };
}

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from([0x00, 0x01, 0x02]);
  return {
    file: buf,
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-policy-1',
    ...overrides,
  };
}

const baseEnv = {
  DATABASE_URL: 'postgresql://test',
  STT_MULTI_PROVIDER: 'false',
  STT_PROVIDERS_ORDER: 'groq',
  STT_DAILY_BUDGET_USD: '10',
  STT_COST_WARN_THRESHOLD_PCT: '0.8',
  STT_MAX_AUDIO_BYTES: '26214400',
  STT_GROQ_API_KEY: 'test-groq-key',
};

const V1 = { policyVersion: 1 as const };

describe('SttRouterService — CONN-1671 per-key policy enforcement', () => {
  beforeEach(() => {
    validateEnv(baseEnv);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('null policy → dispatches unchanged (legacy unrestricted baseline)', async () => {
    const { router, fakeGroq } = buildRouter({ policy: null });
    const envelope = await router.transcribe(makeReq(), 'apikey-null');
    expect(envelope.provider).toBe('groq');
    expect(fakeGroq.transcribe).toHaveBeenCalledTimes(1);
  });

  it('providers:[groq,local-whisper] → groq STT allowed, null-model dispatches', async () => {
    const { router, fakeGroq } = buildRouter({
      policy: { ...V1, providers: ['groq', 'local-whisper'] },
    });
    // No model on the request — STT commonly omits it (prod: 40+ null-model calls).
    const envelope = await router.transcribe(makeReq({ model: undefined }), 'apikey-stt');
    expect(envelope.provider).toBe('groq');
    expect(fakeGroq.transcribe).toHaveBeenCalledTimes(1);
  });

  it('providers:[openrouter] → groq denied → all candidates denied → SttPolicyViolationError', async () => {
    const { router, fakeGroq } = buildRouter({
      policy: { ...V1, providers: ['openrouter'] },
    });
    await expect(router.transcribe(makeReq(), 'apikey-denied')).rejects.toBeInstanceOf(
      SttPolicyViolationError,
    );
    expect(fakeGroq.transcribe).not.toHaveBeenCalled();
  });

  it('SttPolicyViolationError carries the denied provider list', async () => {
    const { router } = buildRouter({ policy: { ...V1, providers: ['openrouter'] } });
    await router.transcribe(makeReq(), 'apikey-denied').catch((err) => {
      expect(err).toBeInstanceOf(SttPolicyViolationError);
      expect((err as SttPolicyViolationError).providersDenied).toEqual(['groq']);
    });
  });

  it('free-only policy + catalog-paid STT model → denied (whisper is not free-tier)', async () => {
    const { router, fakeGroq } = buildRouter({
      policy: { ...V1, providers: ['groq'], models: { mode: 'free-only' } },
      // Catalog resolves the model to paid → free-only denies it.
      getTier: vi.fn().mockResolvedValue('paid'),
    });
    await expect(
      router.transcribe(makeReq({ model: 'whisper-large-v3' }), 'apikey-freeonly'),
    ).rejects.toBeInstanceOf(SttPolicyViolationError);
    expect(fakeGroq.transcribe).not.toHaveBeenCalled();
  });

  it('null request.model + allowed provider → model check skipped, dispatches', async () => {
    const getTier = vi.fn().mockResolvedValue(undefined);
    const { router, fakeGroq } = buildRouter({
      policy: { ...V1, providers: ['groq'], models: { mode: 'free-only' } },
      getTier,
    });
    // NEVER default-deny on a null model — the provider gate governs.
    const envelope = await router.transcribe(makeReq({ model: undefined }), 'apikey-nullmodel');
    expect(envelope.provider).toBe('groq');
    expect(fakeGroq.transcribe).toHaveBeenCalledTimes(1);
    // getTier must not be consulted when there is no model to evaluate.
    expect(getTier).not.toHaveBeenCalled();
  });

  it('malformed stored policy → fail closed with SttPolicyConfigError (no dispatch)', async () => {
    const { router, fakeGroq } = buildRouter({
      getPolicyForKey: vi.fn().mockRejectedValue(new InvalidStoredPolicyError('apikey-bad')),
    });
    await expect(router.transcribe(makeReq(), 'apikey-bad')).rejects.toBeInstanceOf(
      SttPolicyConfigError,
    );
    expect(fakeGroq.transcribe).not.toHaveBeenCalled();
  });

  it('multi-provider: denied provider skipped, allowed provider still attempted', async () => {
    validateEnv({
      ...baseEnv,
      STT_MULTI_PROVIDER: 'true',
      STT_PROVIDERS_ORDER: 'deepgram,groq',
      STT_PROVIDER_DEEPGRAM_ENABLED: 'true',
      STT_DEEPGRAM_API_KEY: 'dg_test_key',
    });
    // Policy allows groq only → deepgram (first in order) is policy-skipped,
    // groq is attempted and succeeds. fallback_count reflects only real attempts.
    const { router, fakeGroq, fakeDeepgram } = buildRouter({
      policy: { ...V1, providers: ['groq'] },
    });
    const envelope = await router.transcribe(makeReq(), 'apikey-mix');
    expect(envelope.provider).toBe('groq');
    expect(envelope.fallback_count).toBe(0);
    expect(fakeDeepgram.transcribe).not.toHaveBeenCalled();
    expect(fakeGroq.transcribe).toHaveBeenCalledTimes(1);
  });
});
