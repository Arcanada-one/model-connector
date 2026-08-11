export type AwsPartition = 'aws' | 'aws-cn' | 'aws-us-gov';

export interface BedrockHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface BedrockHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface BedrockSigningContext {
  service: 'bedrock';
  region: string;
}

export interface BedrockSigner {
  sign(request: BedrockHttpRequest, context: BedrockSigningContext): Promise<BedrockHttpRequest>;
}

export interface BedrockTransport {
  send(request: BedrockHttpRequest): Promise<BedrockHttpResponse>;
}

export interface CanvasImageGenerationConfig {
  width?: number;
  height?: number;
  quality?: 'standard' | 'premium';
  cfgScale?: number;
  seed?: number;
  numberOfImages?: number;
}

export interface CanvasEditingConfig {
  quality?: 'standard' | 'premium';
  cfgScale?: number;
  seed?: number;
  numberOfImages?: number;
}

export type CanvasStyle =
  | '3D_ANIMATED_FAMILY_FILM'
  | 'DESIGN_SKETCH'
  | 'FLAT_VECTOR_ILLUSTRATION'
  | 'GRAPHIC_NOVEL_ILLUSTRATION'
  | 'MAXIMALISM'
  | 'MIDCENTURY_RETRO'
  | 'PHOTOREALISM'
  | 'SOFT_DIGITAL_PAINTING';

export interface CanvasTextToImageParams {
  text: string;
  negativeText?: string;
  style?: CanvasStyle;
  conditionImage?: string;
  controlMode?: 'CANNY_EDGE' | 'SEGMENTATION';
  controlStrength?: number;
}

export interface CanvasColorGuidedParams {
  colors: string[];
  referenceImage?: string;
  text: string;
  negativeText?: string;
}

export interface CanvasImageVariationParams {
  images: string[];
  similarityStrength?: number;
  text?: string;
  negativeText?: string;
}

export interface CanvasInPaintingParams {
  image: string;
  maskPrompt?: string;
  maskImage?: string;
  text?: string;
  negativeText?: string;
}

export interface CanvasOutPaintingParams extends CanvasInPaintingParams {
  outPaintingMode?: 'DEFAULT' | 'PRECISE';
}

export type CanvasMaskToggle = 'ON' | 'OFF' | 'DEFAULT';
export type CanvasMaskShape = 'CONTOUR' | 'BOUNDING_BOX' | 'DEFAULT';

export type CanvasGarmentClass =
  | 'UPPER_BODY'
  | 'LOWER_BODY'
  | 'FULL_BODY'
  | 'FOOTWEAR'
  | 'LONG_SLEEVE_SHIRT'
  | 'SHORT_SLEEVE_SHIRT'
  | 'NO_SLEEVE_SHIRT'
  | 'OTHER_UPPER_BODY'
  | 'LONG_PANTS'
  | 'SHORT_PANTS'
  | 'OTHER_LOWER_BODY'
  | 'LONG_DRESS'
  | 'SHORT_DRESS'
  | 'FULL_BODY_OUTFIT'
  | 'OTHER_FULL_BODY'
  | 'SHOES'
  | 'BOOTS'
  | 'OTHER_FOOTWEAR';

export interface CanvasVirtualTryOnParams {
  sourceImage: string;
  referenceImage: string;
  maskType: 'IMAGE' | 'GARMENT' | 'PROMPT';
  imageBasedMask?: { maskImage: string };
  garmentBasedMask?: {
    maskShape?: CanvasMaskShape;
    garmentClass: CanvasGarmentClass;
    garmentStyling?: {
      longSleeveStyle?: 'SLEEVE_DOWN' | 'SLEEVE_UP';
      tuckingStyle?: 'UNTUCKED' | 'TUCKED';
      outerLayerStyle?: 'CLOSED' | 'OPEN';
    };
  };
  promptBasedMask?: { maskShape?: CanvasMaskShape; maskPrompt: string };
  maskExclusions?: {
    preserveBodyPose?: CanvasMaskToggle;
    preserveHands?: CanvasMaskToggle;
    preserveFace?: CanvasMaskToggle;
  };
  mergeStyle?: 'BALANCED' | 'SEAMLESS' | 'DETAILED';
  returnMask?: boolean;
}

export type CanvasInvokeInput =
  | {
      taskType: 'TEXT_IMAGE';
      textToImageParams: CanvasTextToImageParams;
      imageGenerationConfig?: CanvasImageGenerationConfig;
    }
  | {
      taskType: 'COLOR_GUIDED_GENERATION';
      colorGuidedGenerationParams: CanvasColorGuidedParams;
      imageGenerationConfig?: CanvasImageGenerationConfig;
    }
  | {
      taskType: 'IMAGE_VARIATION';
      imageVariationParams: CanvasImageVariationParams;
      imageGenerationConfig?: CanvasImageGenerationConfig;
    }
  | {
      taskType: 'INPAINTING';
      inPaintingParams: CanvasInPaintingParams;
      imageGenerationConfig?: CanvasEditingConfig;
    }
  | {
      taskType: 'OUTPAINTING';
      outPaintingParams: CanvasOutPaintingParams;
      imageGenerationConfig?: CanvasEditingConfig;
    }
  | {
      taskType: 'BACKGROUND_REMOVAL';
      backgroundRemovalParams: { image: string };
      imageGenerationConfig?: never;
    }
  | {
      taskType: 'VIRTUAL_TRY_ON';
      virtualTryOnParams: CanvasVirtualTryOnParams;
      imageGenerationConfig?: CanvasEditingConfig;
    };

export interface CanvasInvokeCall {
  partition?: AwsPartition;
  region: string;
  modelId: 'amazon.nova-canvas-v1:0';
  input: CanvasInvokeInput;
}

export interface CanvasInvokeResponse {
  images?: string[];
  maskImage?: string;
  error?: string;
}

export type ReelImageSource =
  | { format: 'png' | 'jpeg'; source: { bytes: string } }
  | {
      format: 'png' | 'jpeg';
      source: { s3Location: { uri: string; bucketOwner?: string } };
    };

export interface ReelVideoConfig {
  durationSeconds?: number;
  fps: 24;
  dimension: '1280x720';
  seed?: number;
}

export type ReelModelInput =
  | {
      taskType: 'TEXT_VIDEO';
      textToVideoParams: { text: string; images?: ReelImageSource[] };
      videoGenerationConfig: ReelVideoConfig & { durationSeconds: 6 };
    }
  | {
      taskType: 'MULTI_SHOT_AUTOMATED';
      multiShotAutomatedParams: { text: string };
      videoGenerationConfig: ReelVideoConfig & { durationSeconds: number };
    }
  | {
      taskType: 'MULTI_SHOT_MANUAL';
      multiShotManualParams: {
        shots: Array<{ text: string; image?: ReelImageSource }>;
      };
      videoGenerationConfig: Omit<ReelVideoConfig, 'durationSeconds'>;
    };

export interface ReelS3OutputDataConfig {
  s3OutputDataConfig: {
    s3Uri: string;
    bucketOwner?: string;
    kmsKeyId?: string;
  };
}

export interface ReelStartCall {
  partition?: AwsPartition;
  region: string;
  modelId: 'amazon.nova-reel-v1:0' | 'amazon.nova-reel-v1:1';
  modelInput: ReelModelInput;
  outputDataConfig: ReelS3OutputDataConfig | Record<string, unknown>;
  clientRequestToken?: string;
  tags?: Array<{ key: string; value: string }>;
}

export interface ReelStartResponse {
  invocationArn: string;
}

export type ReelInvocationStatus = 'InProgress' | 'Completed' | 'Failed';

export interface ReelGetCall {
  partition?: AwsPartition;
  region: string;
  invocationArn: string;
}

export interface ReelInvocation {
  clientRequestToken?: string;
  endTime?: string;
  failureMessage?: string;
  invocationArn: string;
  lastModifiedTime?: string;
  modelArn: string;
  outputDataConfig: ReelS3OutputDataConfig;
  status: ReelInvocationStatus;
  submitTime: string;
}

export type ReelAsyncInvokeSummary = Omit<ReelInvocation, 'status'> & {
  status?: ReelInvocationStatus;
};

export interface ReelListCall {
  partition?: AwsPartition;
  region: string;
  maxResults?: number;
  nextToken?: string;
  sortBy?: 'SubmissionTime';
  sortOrder?: 'Ascending' | 'Descending';
  statusEquals?: ReelInvocationStatus;
  submitTimeAfter?: string;
  submitTimeBefore?: string;
}

export interface ReelListResponse {
  asyncInvokeSummaries: ReelAsyncInvokeSummary[];
  nextToken?: string;
}

export type ReelOutputStatus = 'SUCCESS' | 'FAILURE';
export type ReelOutputFailureType =
  | 'INTERNAL_SERVER_EXCEPTION'
  | 'RAI_VIOLATION_OUTPUT_VIDEO_DEFLECTION'
  | 'RATE_LIMIT_EXCEEDED'
  | 'ABORTED';

export interface ReelOutputEntry {
  status: ReelOutputStatus;
  location?: string;
  failureType?: ReelOutputFailureType;
  failureMessage?: string;
}

export interface ReelOutputArtifact {
  schemaVersion: string;
  shots: ReelOutputEntry[];
  fullVideo: ReelOutputEntry;
}
