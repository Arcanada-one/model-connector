import type {
  MetaLlamaGuardClassificationResult,
  MetaLlamaGuardClassificationTarget,
  MetaLlamaGuardErrorCode,
  MetaLlamaGuardGenerate,
  MetaLlamaGuardGenerationRequest,
} from './types';
import {
  deepFreeze,
  hasExactKeys,
  inspectAndCloneSafeValue,
  isSafeRecord,
  serializedUtf8Bytes,
} from './validation';

export const META_LLAMA_GUARD_MODEL_ID = 'meta-llama/Llama-Guard-4-12B' as const;
export const META_LLAMA_GUARD_CONTRACT_VERSION = 'meta-llama-guard-generation/v1' as const;

export const LLAMA_GUARD_4_CATEGORIES = Object.freeze({
  S1: 'Violent Crimes',
  S2: 'Non-Violent Crimes',
  S3: 'Sex-Related Crimes',
  S4: 'Child Sexual Exploitation',
  S5: 'Defamation',
  S6: 'Specialized Advice',
  S7: 'Privacy',
  S8: 'Intellectual Property',
  S9: 'Indiscriminate Weapons',
  S10: 'Hate',
  S11: 'Suicide & Self-Harm',
  S12: 'Sexual Content',
  S13: 'Elections',
  S14: 'Code Interpreter Abuse (text only)',
} as const);

const ERROR_MESSAGES: Readonly<Record<MetaLlamaGuardErrorCode, string>> = Object.freeze({
  invalid_configuration: 'Meta Llama Guard configuration rejected',
  invalid_request: 'Meta Llama Guard request rejected',
  runtime_timeout: 'Meta Llama Guard generation timed out',
  runtime_failure: 'Meta Llama Guard generation failed',
  invalid_generation: 'Meta Llama Guard generation was rejected',
});

const CONFIG_LIMITS = Object.freeze({
  maxDepth: 2,
  maxWidth: 4,
  maxNodes: 8,
  maxArrayLength: 0,
  maxStringLength: 128,
  maxStringBytes: 256,
  allowFunction: true,
});

const REQUEST_LIMITS = Object.freeze({
  maxDepth: 4,
  maxWidth: 16,
  maxNodes: 32,
  maxArrayLength: 4,
  maxStringLength: 16_384,
  maxStringBytes: 65_536,
  allowFunction: false,
});

const GENERATION_LIMITS = Object.freeze({
  maxDepth: 4,
  maxWidth: 16,
  maxNodes: 32,
  maxArrayLength: 4,
  maxStringLength: 128,
  maxStringBytes: 512,
  allowFunction: false,
});

export class MetaLlamaGuardRuntimeError extends Error {
  readonly code: MetaLlamaGuardErrorCode;

  constructor(code: MetaLlamaGuardErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'MetaLlamaGuardRuntimeError';
    this.code = code;
  }
}

const reject = (code: MetaLlamaGuardErrorCode): never => {
  throw new MetaLlamaGuardRuntimeError(code);
};

interface NormalizedConfiguration {
  readonly timeoutMs: number;
  readonly generate: MetaLlamaGuardGenerate;
}

const normalizeConfiguration = (input: unknown): NormalizedConfiguration => {
  try {
    const cloned = inspectAndCloneSafeValue(input, CONFIG_LIMITS);
    if (!isSafeRecord(cloned) || !hasExactKeys(cloned, ['contractVersion', 'modelId', 'timeoutMs', 'generate'])) {
      return reject('invalid_configuration');
    }
    if (
      cloned.contractVersion !== META_LLAMA_GUARD_CONTRACT_VERSION ||
      cloned.modelId !== META_LLAMA_GUARD_MODEL_ID ||
      typeof cloned.generate !== 'function' ||
      !Number.isInteger(cloned.timeoutMs) ||
      (cloned.timeoutMs as number) < 1 ||
      (cloned.timeoutMs as number) > 30_000
    ) {
      return reject('invalid_configuration');
    }
    return {
      timeoutMs: cloned.timeoutMs as number,
      generate: cloned.generate as MetaLlamaGuardGenerate,
    };
  } catch (error: unknown) {
    if (error instanceof MetaLlamaGuardRuntimeError) throw error;
    return reject('invalid_configuration');
  }
};

interface NormalizedClassificationRequest {
  readonly target: MetaLlamaGuardClassificationTarget;
  readonly text: string;
}

const normalizeClassificationRequest = (input: unknown): NormalizedClassificationRequest => {
  try {
    const cloned = inspectAndCloneSafeValue(input, REQUEST_LIMITS);
    if (!isSafeRecord(cloned) || !hasExactKeys(cloned, ['target', 'text'])) {
      return reject('invalid_request');
    }
    if (
      (cloned.target !== 'prompt' && cloned.target !== 'response') ||
      typeof cloned.text !== 'string' ||
      cloned.text.length === 0 ||
      serializedUtf8Bytes(cloned) > 70_000
    ) {
      return reject('invalid_request');
    }
    return { target: cloned.target, text: cloned.text };
  } catch (error: unknown) {
    if (error instanceof MetaLlamaGuardRuntimeError) throw error;
    return reject('invalid_request');
  }
};

const buildGenerationRequest = (
  request: NormalizedClassificationRequest,
): MetaLlamaGuardGenerationRequest =>
  deepFreeze({
    contractVersion: META_LLAMA_GUARD_CONTRACT_VERSION,
    modelId: META_LLAMA_GUARD_MODEL_ID,
    classificationTarget: request.target,
    messages: [
      {
        role: request.target === 'prompt' ? 'user' : 'assistant',
        content: [{ type: 'text', text: request.text }],
      },
    ],
  });

const normalizeGeneratedText = (input: unknown): string => {
  try {
    const cloned = inspectAndCloneSafeValue(input, GENERATION_LIMITS);
    if (
      !isSafeRecord(cloned) ||
      !hasExactKeys(cloned, ['contractVersion', 'modelId', 'generatedText']) ||
      cloned.contractVersion !== META_LLAMA_GUARD_CONTRACT_VERSION ||
      cloned.modelId !== META_LLAMA_GUARD_MODEL_ID ||
      typeof cloned.generatedText !== 'string' ||
      serializedUtf8Bytes(cloned) > 1_024
    ) {
      return reject('invalid_generation');
    }
    return cloned.generatedText;
  } catch (error: unknown) {
    if (error instanceof MetaLlamaGuardRuntimeError) throw error;
    return reject('invalid_generation');
  }
};

const parseGeneration = (
  generatedText: string,
  target: MetaLlamaGuardClassificationTarget,
): MetaLlamaGuardClassificationResult => {
  if (generatedText === 'safe') {
    return deepFreeze({
      modelId: META_LLAMA_GUARD_MODEL_ID,
      target,
      verdict: 'safe',
      categories: [],
    });
  }

  const match = generatedText.match(/^unsafe\n(S(?:[1-9]|1[0-4]))$/);
  if (!match) return reject('invalid_generation');
  const code = match[1] as keyof typeof LLAMA_GUARD_4_CATEGORIES;
  return deepFreeze({
    modelId: META_LLAMA_GUARD_MODEL_ID,
    target,
    verdict: 'unsafe',
    categories: [{ code, label: LLAMA_GUARD_4_CATEGORIES[code] }],
  });
};

export class MetaLlamaGuardRuntimeConnector {
  private readonly timeoutMs: number;
  private readonly generate: MetaLlamaGuardGenerate;

  constructor(configuration: unknown) {
    const normalized = normalizeConfiguration(configuration);
    this.timeoutMs = normalized.timeoutMs;
    this.generate = normalized.generate;
  }

  classify(input: unknown): Promise<MetaLlamaGuardClassificationResult> {
    let request: NormalizedClassificationRequest;
    try {
      request = normalizeClassificationRequest(input);
    } catch (error: unknown) {
      const rejected = Promise.reject(error);
      void rejected.catch(() => undefined);
      return rejected;
    }
    const generationRequest = buildGenerationRequest(request);
    const pending = this.runGeneration(generationRequest, request.target);
    void pending.catch(() => undefined);
    return pending;
  }

  private async runGeneration(
    generationRequest: MetaLlamaGuardGenerationRequest,
    target: MetaLlamaGuardClassificationTarget,
  ): Promise<MetaLlamaGuardClassificationResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generated: Promise<unknown>;
    try {
      generated = Promise.resolve(this.generate(generationRequest)).catch(() =>
        reject('runtime_failure'),
      );
    } catch {
      generated = Promise.reject(new MetaLlamaGuardRuntimeError('runtime_failure'));
    }
    const timeout = new Promise<never>((_resolve, rejectPromise) => {
      timer = setTimeout(
        () => rejectPromise(new MetaLlamaGuardRuntimeError('runtime_timeout')),
        this.timeoutMs,
      );
    });

    try {
      const rawGeneration = await Promise.race([generated, timeout]);
      return parseGeneration(normalizeGeneratedText(rawGeneration), target);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
