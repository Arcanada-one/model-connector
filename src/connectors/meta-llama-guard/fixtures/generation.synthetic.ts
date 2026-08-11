/**
 * Handwritten deterministic synthetic generation envelopes for CONN-0292.
 * These values were never captured, copied, replayed, transformed, paraphrased,
 * or derived from a model, runtime, provider response, or authenticated source.
 */

export const SYNTHETIC_CONTRACT_VERSION = 'meta-llama-guard-generation/v1' as const;
export const SYNTHETIC_MODEL_ID = 'meta-llama/Llama-Guard-4-12B' as const;

export const SAFE_GENERATION_SYNTHETIC = Object.freeze({
  contractVersion: SYNTHETIC_CONTRACT_VERSION,
  modelId: SYNTHETIC_MODEL_ID,
  generatedText: 'safe',
});

export const UNSAFE_GENERATIONS_SYNTHETIC = Object.freeze([
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS1' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS2' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS3' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS4' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS5' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS6' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS7' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS8' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS9' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS10' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS11' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS12' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS13' }),
  Object.freeze({ contractVersion: SYNTHETIC_CONTRACT_VERSION, modelId: SYNTHETIC_MODEL_ID, generatedText: 'unsafe\nS14' }),
]);
