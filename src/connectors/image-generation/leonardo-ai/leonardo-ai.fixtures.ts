const utf8 = (value: string): number[] => [...new TextEncoder().encode(value)];
export const PLACEHOLDER_API_KEY = 'PLACEHOLDER_CONN_0275_LEONARDO';
export const GENERATION_ID = '11111111-1111-4111-8111-111111111111';
export const IMAGE_ID = '22222222-2222-4222-8222-222222222222';
export const INIT_IMAGE_ID = '33333333-3333-4333-8333-333333333333';
export const VARIATION_ID = '44444444-4444-4444-8444-444444444444';
export const MODEL_ID = '55555555-5555-4555-8555-555555555555';
export const STYLE_UUID = '66666666-6666-4666-8666-666666666666';
export const BASE_URL = 'https://cloud.leonardo.ai/api/rest/v1';
export const GENERATION_REQUEST = {
  prompt: 'A precise offline fixture',
  modelId: MODEL_ID,
  width: 1024,
  height: 768,
  num_images: 1,
  negative_prompt: 'blur',
  presetStyle: 'CINEMATIC' as const,
  styleUUID: STYLE_UUID,
  alchemy: true,
  contrast: 3.5,
  ultra: false,
  enhancePrompt: true,
  enhancePromptInstruction: 'Preserve the composition',
  public: false,
  init_generation_image_id: IMAGE_ID,
  init_image_id: INIT_IMAGE_ID,
  init_strength: 0.5,
  controlnets: [
    {
      initImageId: INIT_IMAGE_ID,
      initImageType: 'UPLOADED' as const,
      preprocessorId: 67,
      weight: 1.25,
      strengthType: 'High' as const,
    },
  ],
  canvasRequest: true,
  canvasRequestType: 'INPAINT' as const,
  canvasInitId: INIT_IMAGE_ID,
  canvasMaskId: '77777777-7777-4777-8777-777777777777',
};
export const CREATE_GENERATION_RESPONSE = {
  sdGenerationJob: {
    generationId: GENERATION_ID,
    apiCreditCost: 7,
    cost: { amount: '0.04', unit: 'DOLLARS' as const },
  },
};
export const PENDING_GENERATION_RESPONSE = {
  generations_by_pk: {
    createdAt: '2026-07-14T00:00:00.000Z',
    generated_images: [],
    id: GENERATION_ID,
    imageHeight: 768,
    imageWidth: 1024,
    modelId: MODEL_ID,
    prompt: GENERATION_REQUEST.prompt,
    public: false,
    status: 'PENDING' as const,
  },
};
export const COMPLETE_GENERATION_RESPONSE = {
  generations_by_pk: {
    ...PENDING_GENERATION_RESPONSE.generations_by_pk,
    status: 'COMPLETE' as const,
    generated_images: [
      {
        id: IMAGE_ID,
        url: 'https://cdn.leonardo.ai/offline/image.png',
        likeCount: 0,
        nsfw: false,
        fantasyAvatar: null,
        generated_image_variation_generics: [
          {
            id: VARIATION_ID,
            status: 'COMPLETE' as const,
            transformType: 'UPSCALE' as const,
            url: 'https://cdn.leonardo.ai/offline/upscaled.png',
          },
        ],
      },
    ],
  },
};
export const FAILED_GENERATION_RESPONSE = {
  generations_by_pk: {
    ...PENDING_GENERATION_RESPONSE.generations_by_pk,
    status: 'FAILED' as const,
  },
};
export const DELETE_GENERATION_RESPONSE = {
  delete_generations_by_pk: { id: GENERATION_ID },
};
export const INIT_UPLOAD_FIELDS = JSON.stringify({
  key: 'uploads/init.png',
  policy: 'policy-value',
  'x-amz-signature': 'signature-value',
});
export const INIT_UPLOAD_RESPONSE = {
  uploadInitImage: {
    fields: INIT_UPLOAD_FIELDS,
    id: INIT_IMAGE_ID,
    key: 'uploads/init.png',
    url: 'https://presigned.example.test/',
  },
};
export const INIT_IMAGE_RESPONSE = {
  init_images_by_pk: {
    createdAt: '2026-07-14T00:00:00.000Z',
    id: INIT_IMAGE_ID,
    url: 'https://cdn.leonardo.ai/offline/init.png',
  },
};
export const DELETE_INIT_IMAGE_RESPONSE = {
  delete_init_images_by_pk: { id: INIT_IMAGE_ID },
};
export const UPSCALE_RESPONSE = {
  sdUpscaleJob: {
    id: VARIATION_ID,
    apiCreditCost: 3,
    cost: { amount: '3', unit: 'CREDITS' as const },
  },
};
export const NO_BACKGROUND_RESPONSE = {
  sdNobgJob: {
    id: VARIATION_ID,
    apiCreditCost: null,
    cost: { amount: '0.01', unit: 'DOLLARS' as const },
  },
};
export const UNIVERSAL_UPSCALER_REQUEST = {
  creativityStrength: 5,
  detailContrast: 7,
  generatedImageId: IMAGE_ID,
  initImageId: INIT_IMAGE_ID,
  prompt: 'Restore fine detail',
  similarity: 8,
  ultraUpscaleStyle: 'REALISTIC' as const,
  upscaleMultiplier: 1.5,
  variationId: VARIATION_ID,
};
export const UNIVERSAL_UPSCALER_RESPONSE = {
  universalUpscaler: {
    id: VARIATION_ID,
    apiCreditCost: 9,
    cost: { amount: '9', unit: 'CREDITS' as const },
  },
};
export const PENDING_VARIATION_RESPONSE = {
  generated_image_variation_generic: [
    {
      createdAt: '2026-07-14T00:00:00.000Z',
      id: VARIATION_ID,
      status: 'PENDING' as const,
      transformType: 'UPSCALE' as const,
      url: null,
    },
  ],
};
export const COMPLETE_VARIATION_RESPONSE = {
  generated_image_variation_generic: [
    {
      ...PENDING_VARIATION_RESPONSE.generated_image_variation_generic[0],
      status: 'COMPLETE' as const,
      url: 'https://cdn.leonardo.ai/offline/upscaled.png',
    },
  ],
};
export const PLATFORM_MODELS_RESPONSE = {
  custom_models: [
    {
      id: MODEL_ID,
      name: 'Offline platform model fixture',
      description: 'A deterministic model record',
      featured: true,
      nsfw: false,
      generated_image: {
        id: IMAGE_ID,
        url: 'https://cdn.leonardo.ai/offline/preview.png',
      },
    },
  ],
};
export const PROVIDER_ERROR_RESPONSE = {
  error: 'Authentication hook unauthorized this request',
  path: '$',
  code: 'access-denied',
};
export const MULTIPART_BOUNDARY = 'CONN-0275-BOUNDARY';
export const INIT_FILE_BYTES = Uint8Array.from([137, 80, 78, 71]);
const multipartPrefix =
  `--${MULTIPART_BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="key"\r\n\r\n' +
  'uploads/init.png\r\n' +
  `--${MULTIPART_BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="policy"\r\n\r\n' +
  'policy-value\r\n' +
  `--${MULTIPART_BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="x-amz-signature"\r\n\r\n' +
  'signature-value\r\n' +
  `--${MULTIPART_BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="file"; filename="init.png"\r\n' +
  'Content-Type: image/png\r\n\r\n';
const multipartSuffix = `\r\n--${MULTIPART_BOUNDARY}--\r\n`;
export const EXPECTED_MULTIPART_BYTES = Uint8Array.from([
  ...utf8(multipartPrefix),
  ...INIT_FILE_BYTES,
  ...utf8(multipartSuffix),
]);
