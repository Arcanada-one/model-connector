import {
  CANVAS_MODEL,
  CANVAS_REGIONS,
  REEL_MODELS,
  REEL_V1_1_REGIONS,
  REEL_V1_REGIONS,
} from './nova-media.contract';
import type {
  CanvasImageGenerationConfig,
  CanvasInvokeCall,
  CanvasInvokeInput,
  CanvasVirtualTryOnParams,
  ReelGetCall,
  ReelImageSource,
  ReelInvocation,
  ReelListCall,
  ReelListResponse,
  ReelModelInput,
  ReelOutputArtifact,
  ReelOutputEntry,
  ReelS3OutputDataConfig,
  ReelStartCall,
  ReelStartResponse,
  ReelVideoConfig,
} from './nova-media.types';

const MAX_SEED = 2_147_483_646;
const INVOCATION_ARN =
  /^arn:aws(?:-[^:]+)?:bedrock:([a-z0-9-]{1,20}):[0-9]{12}:async-invoke\/[a-z0-9]{12}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const S3_URI = /^s3:\/\/[a-z0-9][.\-a-z0-9]{1,61}[a-z0-9](\/.*)?$/;
const KMS_KEY =
  /^arn:aws(?:-[^:]+)?:kms:[A-Za-z0-9-]*:[0-9]{12}:(?:key\/[A-Za-z0-9-]{36}|alias\/[A-Za-z0-9-_/]+)$/;
const TAG_VALUE = /^[a-zA-Z0-9\s._:/=+@-]*$/;

function fail(message: string): never {
  throw new Error(`Nova media validation: ${message}`);
}

function assertString(
  value: unknown,
  label: string,
  max: number,
  min = 1,
): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${label} must contain ${min}-${max} characters`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of: ${allowed.join(', ')}`);
  }
}

function assertIntRange(value: unknown, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} must be an integer from ${min} through ${max}`);
  }
}

function assertNumberRange(value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} must be from ${min} through ${max}`);
  }
}

function assertOnlyKeys(value: object, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
}

function validateBase64(value: unknown, label: string): void {
  assertString(value, label, Number.MAX_SAFE_INTEGER);
  if (!BASE64.test(value)) fail(`${label} must be Base64`);
}

function validateOptionalPrompt(value: unknown, label: string, max = 1024): void {
  if (value !== undefined) assertString(value, label, max);
}

function validateGenerationConfig(
  config: CanvasImageGenerationConfig | undefined,
  dimensionsAllowed: boolean,
): void {
  if (!config) return;
  assertOnlyKeys(
    config,
    dimensionsAllowed
      ? ['width', 'height', 'quality', 'cfgScale', 'seed', 'numberOfImages']
      : ['quality', 'cfgScale', 'seed', 'numberOfImages'],
    'imageGenerationConfig',
  );
  if (!dimensionsAllowed && (config.width !== undefined || config.height !== undefined)) {
    fail('editing image generation config does not accept width or height');
  }
  validateCanvasDimensions(config);
  if (config.quality !== undefined) {
    assertEnum(config.quality, ['standard', 'premium'], 'quality');
  }
  if (config.cfgScale !== undefined) assertNumberRange(config.cfgScale, 1.1, 10, 'cfgScale');
  if (config.seed !== undefined) assertIntRange(config.seed, 0, MAX_SEED, 'seed');
  if (config.numberOfImages !== undefined) {
    assertIntRange(config.numberOfImages, 1, 5, 'numberOfImages');
  }
}

function validateCanvasDimensions(config: CanvasImageGenerationConfig): void {
  if ((config.width === undefined) !== (config.height === undefined)) {
    fail('width and height must be supplied together');
  }
  if (config.width === undefined || config.height === undefined) return;
  assertIntRange(config.width, 320, 4096, 'width');
  assertIntRange(config.height, 320, 4096, 'height');
  if (config.width % 16 !== 0 || config.height % 16 !== 0) {
    fail('generation width and height must be divisible by 16');
  }
  const ratio = config.width / config.height;
  if (ratio < 0.25 || ratio > 4) fail('generation aspect ratio must be between 1:4 and 4:1');
  if (config.width * config.height >= 4_194_304) {
    fail('generation total pixels must be fewer than 4,194,304');
  }
}

function validateMaskPair(params: { maskPrompt?: string; maskImage?: string }): void {
  const count = Number(params.maskPrompt !== undefined) + Number(params.maskImage !== undefined);
  if (count !== 1) fail('inpainting and outpainting require exactly one mask form');
  validateOptionalPrompt(params.maskPrompt, 'maskPrompt');
  if (params.maskImage !== undefined) validateBase64(params.maskImage, 'maskImage');
}

function validateVirtualTryOn(params: CanvasVirtualTryOnParams): void {
  assertOnlyKeys(
    params,
    [
      'sourceImage',
      'referenceImage',
      'maskType',
      'imageBasedMask',
      'garmentBasedMask',
      'promptBasedMask',
      'maskExclusions',
      'mergeStyle',
      'returnMask',
    ],
    'virtualTryOnParams',
  );
  validateBase64(params.sourceImage, 'sourceImage');
  validateBase64(params.referenceImage, 'referenceImage');
  assertEnum(params.maskType, ['IMAGE', 'GARMENT', 'PROMPT'], 'maskType');
  const masks = [
    params.imageBasedMask !== undefined,
    params.garmentBasedMask !== undefined,
    params.promptBasedMask !== undefined,
  ].filter(Boolean).length;
  if (masks !== 1) fail('virtual try-on requires exactly one mask object');
  if (params.maskType === 'IMAGE' && !params.imageBasedMask) fail('IMAGE requires imageBasedMask');
  if (params.maskType === 'GARMENT' && !params.garmentBasedMask) {
    fail('GARMENT requires garmentBasedMask');
  }
  if (params.maskType === 'PROMPT' && !params.promptBasedMask) {
    fail('PROMPT requires promptBasedMask');
  }
  if (params.imageBasedMask) {
    const imageBasedMask = asRecord(params.imageBasedMask, 'imageBasedMask');
    assertOnlyKeys(imageBasedMask, ['maskImage'], 'imageBasedMask');
    validateBase64(imageBasedMask.maskImage, 'maskImage');
  }
  if (params.promptBasedMask) {
    const promptBasedMask = asRecord(params.promptBasedMask, 'promptBasedMask');
    assertOnlyKeys(promptBasedMask, ['maskShape', 'maskPrompt'], 'promptBasedMask');
    assertString(promptBasedMask.maskPrompt, 'maskPrompt', 1024);
    if (promptBasedMask.maskShape !== undefined) {
      assertEnum(promptBasedMask.maskShape, ['CONTOUR', 'BOUNDING_BOX', 'DEFAULT'], 'maskShape');
    }
  }
  if (params.garmentBasedMask) {
    const garmentBasedMask = asRecord(params.garmentBasedMask, 'garmentBasedMask');
    assertOnlyKeys(
      garmentBasedMask,
      ['maskShape', 'garmentClass', 'garmentStyling'],
      'garmentBasedMask',
    );
    if (garmentBasedMask.maskShape !== undefined) {
      assertEnum(garmentBasedMask.maskShape, ['CONTOUR', 'BOUNDING_BOX', 'DEFAULT'], 'maskShape');
    }
    assertEnum(
      garmentBasedMask.garmentClass,
      [
        'UPPER_BODY',
        'LOWER_BODY',
        'FULL_BODY',
        'FOOTWEAR',
        'LONG_SLEEVE_SHIRT',
        'SHORT_SLEEVE_SHIRT',
        'NO_SLEEVE_SHIRT',
        'OTHER_UPPER_BODY',
        'LONG_PANTS',
        'SHORT_PANTS',
        'OTHER_LOWER_BODY',
        'LONG_DRESS',
        'SHORT_DRESS',
        'FULL_BODY_OUTFIT',
        'OTHER_FULL_BODY',
        'SHOES',
        'BOOTS',
        'OTHER_FOOTWEAR',
      ],
      'garmentClass',
    );
    if (garmentBasedMask.garmentStyling !== undefined) {
      const styling = asRecord(garmentBasedMask.garmentStyling, 'garmentStyling');
      assertOnlyKeys(
        styling,
        ['longSleeveStyle', 'tuckingStyle', 'outerLayerStyle'],
        'garmentStyling',
      );
      if (styling.longSleeveStyle !== undefined) {
        assertEnum(styling.longSleeveStyle, ['SLEEVE_DOWN', 'SLEEVE_UP'], 'longSleeveStyle');
      }
      if (styling.tuckingStyle !== undefined) {
        assertEnum(styling.tuckingStyle, ['UNTUCKED', 'TUCKED'], 'tuckingStyle');
      }
      if (styling.outerLayerStyle !== undefined) {
        assertEnum(styling.outerLayerStyle, ['CLOSED', 'OPEN'], 'outerLayerStyle');
      }
    }
  }
  if (params.mergeStyle !== undefined) {
    assertEnum(params.mergeStyle, ['BALANCED', 'SEAMLESS', 'DETAILED'], 'mergeStyle');
  }
  if (params.maskExclusions !== undefined) {
    const maskExclusions = asRecord(params.maskExclusions, 'maskExclusions');
    assertOnlyKeys(
      maskExclusions,
      ['preserveBodyPose', 'preserveHands', 'preserveFace'],
      'maskExclusions',
    );
    for (const value of Object.values(maskExclusions)) {
      assertEnum(value, ['ON', 'OFF', 'DEFAULT'], 'mask exclusion');
    }
  }
  if (params.returnMask !== undefined && typeof params.returnMask !== 'boolean') {
    fail('returnMask must be boolean');
  }
}

function validateCanvasTask(input: CanvasInvokeInput): void {
  switch (input.taskType) {
    case 'TEXT_IMAGE':
      assertOnlyKeys(input, ['taskType', 'textToImageParams', 'imageGenerationConfig'], 'request');
      assertOnlyKeys(
        input.textToImageParams,
        ['text', 'negativeText', 'style', 'conditionImage', 'controlMode', 'controlStrength'],
        'textToImageParams',
      );
      assertString(input.textToImageParams.text, 'text', 1024);
      validateOptionalPrompt(input.textToImageParams.negativeText, 'negativeText');
      if (
        (input.textToImageParams.controlMode !== undefined ||
          input.textToImageParams.controlStrength !== undefined) &&
        input.textToImageParams.conditionImage === undefined
      ) {
        fail('controlMode and controlStrength require conditionImage');
      }
      if (input.textToImageParams.conditionImage !== undefined) {
        validateBase64(input.textToImageParams.conditionImage, 'conditionImage');
      }
      if (input.textToImageParams.controlStrength !== undefined) {
        assertNumberRange(input.textToImageParams.controlStrength, 0, 1, 'controlStrength');
      }
      if (input.textToImageParams.controlMode !== undefined) {
        assertEnum(
          input.textToImageParams.controlMode,
          ['CANNY_EDGE', 'SEGMENTATION'],
          'controlMode',
        );
      }
      if (input.textToImageParams.style !== undefined) {
        assertEnum(
          input.textToImageParams.style,
          [
            '3D_ANIMATED_FAMILY_FILM',
            'DESIGN_SKETCH',
            'FLAT_VECTOR_ILLUSTRATION',
            'GRAPHIC_NOVEL_ILLUSTRATION',
            'MAXIMALISM',
            'MIDCENTURY_RETRO',
            'PHOTOREALISM',
            'SOFT_DIGITAL_PAINTING',
          ],
          'style',
        );
      }
      break;
    case 'COLOR_GUIDED_GENERATION':
      assertOnlyKeys(
        input,
        ['taskType', 'colorGuidedGenerationParams', 'imageGenerationConfig'],
        'request',
      );
      assertOnlyKeys(
        input.colorGuidedGenerationParams,
        ['colors', 'referenceImage', 'text', 'negativeText'],
        'colorGuidedGenerationParams',
      );
      if (
        input.colorGuidedGenerationParams.colors.length < 1 ||
        input.colorGuidedGenerationParams.colors.length > 10 ||
        input.colorGuidedGenerationParams.colors.some((color) => !/^#[0-9A-Fa-f]{6}$/.test(color))
      ) {
        fail('colors must contain 1-10 #RRGGBB values');
      }
      assertString(input.colorGuidedGenerationParams.text, 'text', 1024);
      validateOptionalPrompt(input.colorGuidedGenerationParams.negativeText, 'negativeText');
      if (input.colorGuidedGenerationParams.referenceImage !== undefined) {
        validateBase64(input.colorGuidedGenerationParams.referenceImage, 'referenceImage');
      }
      break;
    case 'IMAGE_VARIATION':
      assertOnlyKeys(
        input,
        ['taskType', 'imageVariationParams', 'imageGenerationConfig'],
        'request',
      );
      assertOnlyKeys(
        input.imageVariationParams,
        ['images', 'similarityStrength', 'text', 'negativeText'],
        'imageVariationParams',
      );
      if (
        input.imageVariationParams.images.length < 1 ||
        input.imageVariationParams.images.length > 5
      ) {
        fail('image variation requires 1-5 images');
      }
      input.imageVariationParams.images.forEach((image) => validateBase64(image, 'image'));
      if (input.imageVariationParams.similarityStrength !== undefined) {
        assertNumberRange(
          input.imageVariationParams.similarityStrength,
          0.2,
          1,
          'similarityStrength',
        );
      }
      validateOptionalPrompt(input.imageVariationParams.text, 'text');
      validateOptionalPrompt(input.imageVariationParams.negativeText, 'negativeText');
      break;
    case 'INPAINTING':
      assertOnlyKeys(input, ['taskType', 'inPaintingParams', 'imageGenerationConfig'], 'request');
      assertOnlyKeys(
        input.inPaintingParams,
        ['image', 'maskPrompt', 'maskImage', 'text', 'negativeText'],
        'inPaintingParams',
      );
      validateBase64(input.inPaintingParams.image, 'image');
      validateMaskPair(input.inPaintingParams);
      validateOptionalPrompt(input.inPaintingParams.text, 'text');
      validateOptionalPrompt(input.inPaintingParams.negativeText, 'negativeText');
      break;
    case 'OUTPAINTING':
      assertOnlyKeys(input, ['taskType', 'outPaintingParams', 'imageGenerationConfig'], 'request');
      assertOnlyKeys(
        input.outPaintingParams,
        ['image', 'maskPrompt', 'maskImage', 'outPaintingMode', 'text', 'negativeText'],
        'outPaintingParams',
      );
      validateBase64(input.outPaintingParams.image, 'image');
      validateMaskPair(input.outPaintingParams);
      validateOptionalPrompt(input.outPaintingParams.text, 'text');
      validateOptionalPrompt(input.outPaintingParams.negativeText, 'negativeText');
      if (input.outPaintingParams.outPaintingMode !== undefined) {
        assertEnum(
          input.outPaintingParams.outPaintingMode,
          ['DEFAULT', 'PRECISE'],
          'outPaintingMode',
        );
      }
      break;
    case 'BACKGROUND_REMOVAL':
      if ('imageGenerationConfig' in input && input.imageGenerationConfig !== undefined) {
        fail('background removal does not accept an image generation config');
      }
      assertOnlyKeys(input, ['taskType', 'backgroundRemovalParams'], 'request');
      assertOnlyKeys(input.backgroundRemovalParams, ['image'], 'backgroundRemovalParams');
      validateBase64(input.backgroundRemovalParams.image, 'image');
      break;
    case 'VIRTUAL_TRY_ON':
      assertOnlyKeys(input, ['taskType', 'virtualTryOnParams', 'imageGenerationConfig'], 'request');
      validateVirtualTryOn(input.virtualTryOnParams);
      break;
    default:
      fail('unsupported Canvas taskType');
  }
}

export function validateCanvasCall(call: CanvasInvokeCall): void {
  if ((call.partition ?? 'aws') !== 'aws') fail('Nova Canvas is not documented for this partition');
  if (call.modelId !== CANVAS_MODEL) fail(`unsupported Canvas model: ${call.modelId}`);
  assertEnum(call.region, CANVAS_REGIONS, 'Canvas region');
  validateCanvasTask(call.input);
  validateGenerationConfig(
    call.input.imageGenerationConfig,
    ['TEXT_IMAGE', 'COLOR_GUIDED_GENERATION', 'IMAGE_VARIATION'].includes(call.input.taskType),
  );
}

function validateImageSource(image: ReelImageSource): void {
  assertOnlyKeys(image, ['format', 'source'], 'image');
  assertOnlyKeys(image.source, ['bytes', 's3Location'], 'image source');
  assertEnum(image.format, ['png', 'jpeg'], 'image format');
  if ('bytes' in image.source) {
    validateBase64(image.source.bytes, 'image bytes');
    return;
  }
  assertString(image.source.s3Location.uri, 'image S3 URI', 1024);
  if (!S3_URI.test(image.source.s3Location.uri)) fail('image S3 URI is invalid');
  const owner = image.source.s3Location.bucketOwner;
  if (owner !== undefined && !/^[0-9]{12}$/.test(owner)) {
    fail('image bucketOwner must be 12 digits');
  }
}

function validateVideoConfig(config: ReelVideoConfig): void {
  assertOnlyKeys(config, ['durationSeconds', 'fps', 'dimension', 'seed'], 'videoGenerationConfig');
  if (config.fps !== 24) fail('fps must be 24');
  if (config.dimension !== '1280x720') fail('dimension must be 1280x720');
  if (config.seed !== undefined) assertIntRange(config.seed, 0, MAX_SEED, 'seed');
}

function validateReelTask(input: ReelModelInput): void {
  validateVideoConfig(input.videoGenerationConfig);
  switch (input.taskType) {
    case 'TEXT_VIDEO':
      assertOnlyKeys(
        input,
        ['taskType', 'textToVideoParams', 'videoGenerationConfig'],
        'modelInput',
      );
      assertOnlyKeys(input.textToVideoParams, ['text', 'images'], 'textToVideoParams');
      assertString(input.textToVideoParams.text, 'text', 512);
      if (input.textToVideoParams.images && input.textToVideoParams.images.length > 1) {
        fail('TEXT_VIDEO accepts at most one image');
      }
      input.textToVideoParams.images?.forEach(validateImageSource);
      if (input.videoGenerationConfig.durationSeconds !== 6) fail('TEXT_VIDEO duration must be 6');
      break;
    case 'MULTI_SHOT_AUTOMATED':
      assertOnlyKeys(
        input,
        ['taskType', 'multiShotAutomatedParams', 'videoGenerationConfig'],
        'modelInput',
      );
      assertOnlyKeys(input.multiShotAutomatedParams, ['text'], 'multiShotAutomatedParams');
      assertString(input.multiShotAutomatedParams.text, 'text', 4000);
      assertIntRange(input.videoGenerationConfig.durationSeconds, 12, 120, 'durationSeconds');
      if (input.videoGenerationConfig.durationSeconds % 6 !== 0) {
        fail('automated duration must be a multiple of 6');
      }
      break;
    case 'MULTI_SHOT_MANUAL':
      assertOnlyKeys(
        input,
        ['taskType', 'multiShotManualParams', 'videoGenerationConfig'],
        'modelInput',
      );
      assertOnlyKeys(input.multiShotManualParams, ['shots'], 'multiShotManualParams');
      if ('durationSeconds' in input.videoGenerationConfig) {
        fail('manual multi-shot does not accept durationSeconds');
      }
      if (
        input.multiShotManualParams.shots.length < 1 ||
        input.multiShotManualParams.shots.length > 20
      ) {
        fail('manual multi-shot requires 1-20 shots');
      }
      for (const shot of input.multiShotManualParams.shots) {
        assertString(shot.text, 'shot text', 512);
        if (shot.image) validateImageSource(shot.image);
      }
      break;
    default:
      fail('unsupported Reel taskType');
  }
}

function validateOutputConfig(value: unknown): asserts value is ReelS3OutputDataConfig {
  if (!value || typeof value !== 'object' || !('s3OutputDataConfig' in value)) {
    fail('outputDataConfig must contain s3OutputDataConfig');
  }
  assertOnlyKeys(value, ['s3OutputDataConfig'], 'outputDataConfig');
  const config = (value as ReelS3OutputDataConfig).s3OutputDataConfig;
  if (!config || typeof config !== 'object') fail('s3OutputDataConfig must be an object');
  assertOnlyKeys(config, ['s3Uri', 'bucketOwner', 'kmsKeyId'], 's3OutputDataConfig');
  assertString(config?.s3Uri, 'output s3Uri', 1024);
  if (!S3_URI.test(config.s3Uri)) fail('output s3Uri is invalid');
  if (config.bucketOwner !== undefined && !/^[0-9]{12}$/.test(config.bucketOwner)) {
    fail('output bucketOwner must be 12 digits');
  }
  if (config.kmsKeyId !== undefined) {
    assertString(config.kmsKeyId, 'kmsKeyId', 2048);
    if (!KMS_KEY.test(config.kmsKeyId)) fail('kmsKeyId is invalid');
  }
}

export function validateReelStartCall(call: ReelStartCall): void {
  if ((call.partition ?? 'aws') !== 'aws') fail('Nova Reel is not documented for this partition');
  assertEnum(call.modelId, REEL_MODELS, 'Reel model');
  const regions = call.modelId === REEL_MODELS[1] ? REEL_V1_1_REGIONS : REEL_V1_REGIONS;
  assertEnum(call.region, regions, 'Reel region');
  if (call.modelId === REEL_MODELS[0] && call.modelInput.taskType !== 'TEXT_VIDEO') {
    fail('multi-shot Reel tasks require model amazon.nova-reel-v1:1');
  }
  validateReelTask(call.modelInput);
  validateOutputConfig(call.outputDataConfig);
  if (call.clientRequestToken !== undefined) {
    assertString(call.clientRequestToken, 'clientRequestToken', 256);
    if (!/^[!-~]+$/.test(call.clientRequestToken))
      fail('clientRequestToken must be printable ASCII');
  }
  if (call.tags !== undefined) {
    if (!Array.isArray(call.tags)) fail('tags must be an array');
    if (call.tags.length > 200) fail('tags must contain at most 200 entries');
    call.tags.forEach((value, index) => {
      const tag = asRecord(value, `tags[${index}]`);
      assertOnlyKeys(tag, ['key', 'value'], `tags[${index}]`);
      assertString(tag.key, `tags[${index}].key`, 128);
      assertString(tag.value, `tags[${index}].value`, 256, 0);
      if (!TAG_VALUE.test(tag.key as string)) {
        fail(`tags[${index}].key contains unsupported characters`);
      }
      if (!TAG_VALUE.test(tag.value as string)) {
        fail(`tags[${index}].value contains unsupported characters`);
      }
    });
  }
}

export function validateReelGetCall(call: ReelGetCall): void {
  if ((call.partition ?? 'aws') !== 'aws') fail('Nova Reel is not documented for this partition');
  assertEnum(call.region, REEL_V1_REGIONS, 'Reel region');
  const match = INVOCATION_ARN.exec(call.invocationArn);
  if (!match) fail('invocationArn does not match the Bedrock async invocation ARN');
  if (match[1] !== call.region) fail('invocationArn region must match the signing region');
}

function validateTimestamp(value: string | undefined, label: string): void {
  if (value !== undefined && Number.isNaN(Date.parse(value))) fail(`${label} must be a timestamp`);
}

export function validateReelListCall(call: ReelListCall): void {
  if ((call.partition ?? 'aws') !== 'aws') fail('Nova Reel is not documented for this partition');
  assertEnum(call.region, REEL_V1_REGIONS, 'Reel region');
  if (call.maxResults !== undefined) assertIntRange(call.maxResults, 1, 1000, 'maxResults');
  if (call.nextToken !== undefined) {
    assertString(call.nextToken, 'nextToken', 2048);
    if (/\s/.test(call.nextToken)) fail('nextToken must not contain whitespace');
  }
  if (call.sortBy !== undefined) assertEnum(call.sortBy, ['SubmissionTime'], 'sortBy');
  if (call.sortOrder !== undefined) {
    assertEnum(call.sortOrder, ['Ascending', 'Descending'], 'sortOrder');
  }
  if (call.statusEquals !== undefined) {
    assertEnum(call.statusEquals, ['InProgress', 'Completed', 'Failed'], 'statusEquals');
  }
  validateTimestamp(call.submitTimeAfter, 'submitTimeAfter');
  validateTimestamp(call.submitTimeBefore, 'submitTimeBefore');
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function validateReelStartResponse(value: unknown, region?: string): ReelStartResponse {
  const record = asRecord(value, 'start response');
  assertString(record.invocationArn, 'invocationArn', 2048);
  if (!INVOCATION_ARN.test(record.invocationArn)) fail('start response invocationArn is invalid');
  if (region && INVOCATION_ARN.exec(record.invocationArn)?.[1] !== region) {
    fail('start response invocationArn region must match the signing region');
  }
  return value as ReelStartResponse;
}

function validateReelInvocationShape(value: unknown, requireStatus: boolean): void {
  const record = asRecord(value, 'invocation');
  assertString(record.invocationArn, 'invocationArn', 2048);
  if (!INVOCATION_ARN.test(record.invocationArn)) fail('invocationArn is invalid');
  assertString(record.modelArn, 'modelArn', 2048);
  if (requireStatus || record.status !== undefined) {
    assertEnum(record.status, ['InProgress', 'Completed', 'Failed'], 'status');
  }
  assertString(record.submitTime, 'submitTime', 128);
  validateTimestamp(record.submitTime, 'submitTime');
  validateOutputConfig(record.outputDataConfig);
  if (record.failureMessage !== undefined)
    assertString(record.failureMessage, 'failureMessage', 2048, 0);
}

export function validateReelInvocation(value: unknown): ReelInvocation {
  validateReelInvocationShape(value, true);
  return value as ReelInvocation;
}

export function validateReelListResponse(value: unknown): ReelListResponse {
  const record = asRecord(value, 'list response');
  if (!Array.isArray(record.asyncInvokeSummaries)) fail('asyncInvokeSummaries must be an array');
  record.asyncInvokeSummaries.forEach((summary) => validateReelInvocationShape(summary, false));
  if (record.nextToken !== undefined) assertString(record.nextToken, 'nextToken', 2048);
  return value as ReelListResponse;
}

function validateOutputEntry(value: unknown, label: string): ReelOutputEntry {
  const entry = asRecord(value, label);
  assertEnum(entry.status, ['SUCCESS', 'FAILURE'], `${label}.status`);
  if (entry.status === 'SUCCESS') {
    assertString(entry.location, `${label}.location`, 2048);
    if (entry.failureType !== undefined || entry.failureMessage !== undefined) {
      fail(`${label} success cannot contain failure fields`);
    }
  } else {
    if (entry.location !== undefined) fail(`${label} failed entry cannot contain a location`);
    assertEnum(
      entry.failureType,
      [
        'INTERNAL_SERVER_EXCEPTION',
        'RAI_VIOLATION_OUTPUT_VIDEO_DEFLECTION',
        'RATE_LIMIT_EXCEEDED',
        'ABORTED',
      ],
      `${label}.failureType`,
    );
    assertString(entry.failureMessage, `${label}.failureMessage`, 2048);
  }
  return value as ReelOutputEntry;
}

export function validateReelOutput(value: unknown): ReelOutputArtifact {
  const artifact = asRecord(value, 'video-generation-status');
  assertString(artifact.schemaVersion, 'schemaVersion', 128);
  if (!Array.isArray(artifact.shots)) fail('shots must be an array');
  const shots = artifact.shots.map((shot, index) => validateOutputEntry(shot, `shots[${index}]`));
  const fullVideo = validateOutputEntry(artifact.fullVideo, 'fullVideo');
  if (fullVideo.status === 'SUCCESS' && shots.some((shot) => shot.status !== 'SUCCESS')) {
    fail('fullVideo cannot succeed when a shot failed');
  }
  return value as ReelOutputArtifact;
}
