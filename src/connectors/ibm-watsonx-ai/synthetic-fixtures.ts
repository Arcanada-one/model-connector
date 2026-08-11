// CONN-0294: handwritten deterministic synthetic fixtures.
// These values were not captured from IBM traffic and are not availability claims.

export const SYNTHETIC_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const SYNTHETIC_SPACE_ID = '22222222-2222-4222-8222-222222222222';
export const SYNTHETIC_MODEL_ID = 'synthetic/foundation-model';
export const SYNTHETIC_IMAGE_MODEL_ID = 'synthetic/image-model';

export const SYNTHETIC_TEXT_RESPONSE = {
  model_id: SYNTHETIC_MODEL_ID,
  created_at: '2026-01-01T00:00:00.000Z',
  results: [
    {
      generated_text: 'synthetic completion',
      stop_reason: 'eos_token',
      generated_token_count: 2,
      input_token_count: 3,
    },
  ],
};

export const SYNTHETIC_PROVIDER_ERROR = {
  trace: '33333333-3333-4333-8333-333333333333',
  errors: [
    {
      code: 'synthetic_invalid_request',
      message: 'synthetic provider detail must never escape',
    },
  ],
  status_code: 400,
};

export const SYNTHETIC_IMAGE_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
