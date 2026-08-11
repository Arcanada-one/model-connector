export type LeonardoHttpMethod = 'GET' | 'POST' | 'DELETE';
export interface LeonardoTransportRequest {
  readonly url: string;
  readonly method: LeonardoHttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}
export interface LeonardoTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}
export interface LeonardoTransport {
  request(input: LeonardoTransportRequest): Promise<LeonardoTransportResponse>;
}
export interface LeonardoAiClientOptions {
  readonly apiKey: string;
  readonly transport: LeonardoTransport;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly boundaryFactory?: () => string;
}
export type LeonardoGenerationStatus = 'PENDING' | 'COMPLETE' | 'FAILED';
export type LeonardoPresetStyle =
  | 'ANIME'
  | 'BOKEH'
  | 'CINEMATIC'
  | 'CINEMATIC_CLOSEUP'
  | 'CREATIVE'
  | 'DYNAMIC'
  | 'ENVIRONMENT'
  | 'FASHION'
  | 'FILM'
  | 'FOOD'
  | 'GENERAL'
  | 'HDR'
  | 'ILLUSTRATION'
  | 'LEONARDO'
  | 'LONG_EXPOSURE'
  | 'MACRO'
  | 'MINIMALISTIC'
  | 'MONOCHROME'
  | 'MOODY'
  | 'NONE'
  | 'NEUTRAL'
  | 'PHOTOGRAPHY'
  | 'PORTRAIT'
  | 'RAYTRACED'
  | 'RENDER_3D'
  | 'RETRO'
  | 'SKETCH_BW'
  | 'SKETCH_COLOR'
  | 'STOCK_PHOTO'
  | 'VIBRANT'
  | 'UNPROCESSED';
export interface LeonardoControlNetInput {
  readonly initImageId?: string;
  readonly initImageType?: 'GENERATED' | 'UPLOADED';
  readonly preprocessorId?: number;
  readonly weight?: number | null;
  readonly strengthType?: 'Low' | 'Mid' | 'High' | 'Ultra' | 'Max' | null;
}
export interface LeonardoCreateGenerationRequest {
  readonly prompt: string;
  readonly modelId?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly num_images?: number | null;
  readonly negative_prompt?: string | null;
  readonly presetStyle?: LeonardoPresetStyle | null;
  /** Proved by current first-party guides; absent from the embedded v1 OpenAPI schema. */
  readonly styleUUID?: string | null;
  readonly alchemy?: boolean | null;
  readonly contrast?: number | null;
  readonly ultra?: boolean | null;
  readonly enhancePrompt?: boolean | null;
  readonly enhancePromptInstruction?: string | null;
  readonly public?: boolean | null;
  readonly init_generation_image_id?: string | null;
  readonly init_image_id?: string | null;
  readonly init_strength?: number | null;
  readonly controlnets?: readonly LeonardoControlNetInput[] | null;
  readonly canvasRequest?: boolean | null;
  readonly canvasRequestType?: 'INPAINT' | 'OUTPAINT' | 'SKETCH2IMG' | 'IMG2IMG' | null;
  readonly canvasInitId?: string | null;
  readonly canvasMaskId?: string | null;
}
export interface LeonardoCost {
  readonly amount?: string;
  readonly unit?: 'CREDITS' | 'DOLLARS';
}
export interface LeonardoGenerationJob {
  readonly generationId?: string;
  /** @deprecated Leonardo directs clients to use cost. */
  readonly apiCreditCost?: number | null;
  readonly cost?: LeonardoCost | null;
}
export interface LeonardoCreateGenerationResponse {
  readonly sdGenerationJob?: LeonardoGenerationJob | null;
}
export type LeonardoVariationType = 'OUTPAINT' | 'INPAINT' | 'UPSCALE' | 'UNZOOM' | 'NOBG';
export interface LeonardoVariationAsset {
  readonly createdAt?: string;
  readonly id?: string | null;
  readonly status?: LeonardoGenerationStatus;
  readonly transformType?: LeonardoVariationType;
  readonly url?: string | null;
}
export type LeonardoGenerationVariationAsset = Omit<LeonardoVariationAsset, 'createdAt'>;
export interface LeonardoGeneratedImage {
  readonly generated_image_variation_generics?: readonly LeonardoGenerationVariationAsset[];
  readonly fantasyAvatar?: boolean | null;
  readonly id?: string | null;
  readonly likeCount?: number;
  readonly nsfw?: boolean;
  readonly url?: string;
}
export interface LeonardoGeneration {
  readonly createdAt?: string;
  readonly generated_images?: readonly LeonardoGeneratedImage[];
  readonly id?: string | null;
  readonly imageHeight?: number;
  readonly imageWidth?: number;
  readonly prompt?: string;
  readonly public?: boolean;
  readonly status?: LeonardoGenerationStatus;
  readonly modelId?: string | null;
}
export interface LeonardoGetGenerationResponse {
  readonly generations_by_pk?: LeonardoGeneration | null;
}
export interface LeonardoDeleteGenerationResponse {
  readonly delete_generations_by_pk: {
    readonly id: string;
  } | null;
}
export type LeonardoInitImageExtension = 'png' | 'jpg' | 'jpeg' | 'webp';
export interface LeonardoCreateInitImageUploadRequest {
  readonly extension: LeonardoInitImageExtension;
}
export interface LeonardoInitImageUpload {
  readonly fields: string | null;
  readonly id: string | null;
  readonly key: string | null;
  readonly url: string | null;
}
export interface LeonardoCreateInitImageUploadResponse {
  readonly uploadInitImage: LeonardoInitImageUpload | null;
}
export interface LeonardoInitImageAssetInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
}
export interface LeonardoInitImage {
  readonly createdAt: string;
  readonly id: string;
  readonly url: string;
}
export interface LeonardoGetInitImageResponse {
  readonly init_images_by_pk: LeonardoInitImage | null;
}
export interface LeonardoDeleteInitImageResponse {
  readonly delete_init_images_by_pk: {
    readonly id: string;
  } | null;
}
export interface LeonardoCreateUpscaleRequest {
  readonly id: string;
}
export interface LeonardoCreateNoBackgroundRequest {
  readonly id: string;
  readonly isVariation?: boolean;
}
export interface LeonardoVariationJob {
  readonly id: string;
  /** @deprecated Leonardo directs clients to use cost. */
  readonly apiCreditCost?: number | null;
  readonly cost?: LeonardoCost | null;
}
export interface LeonardoCreateUpscaleResponse {
  readonly sdUpscaleJob: LeonardoVariationJob | null;
}
export interface LeonardoCreateNoBackgroundResponse {
  readonly sdNobgJob: LeonardoVariationJob;
}
export interface LeonardoCreateUniversalUpscalerRequest {
  readonly creativityStrength?: number | null;
  readonly detailContrast?: number | null;
  readonly generatedImageId?: string | null;
  readonly initImageId?: string | null;
  readonly prompt?: string | null;
  readonly similarity?: number | null;
  readonly ultraUpscaleStyle?: 'ARTISTIC' | 'REALISTIC' | null;
  readonly upscaleMultiplier?: number | null;
  readonly upscalerStyle?:
    | 'GENERAL'
    | 'CINEMATIC'
    | '2D ART & ILLUSTRATION'
    | 'CG ART & GAME ASSETS'
    | null;
  readonly variationId?: string | null;
}
export interface LeonardoCreateUniversalUpscalerResponse {
  readonly universalUpscaler: LeonardoVariationJob;
}
export interface LeonardoGetVariationResponse {
  readonly generated_image_variation_generic: readonly LeonardoVariationAsset[];
}
export interface LeonardoPlatformModel {
  readonly description: string;
  readonly featured: boolean;
  readonly generated_image: {
    readonly id: string;
    readonly url: string;
  } | null;
  readonly id: string;
  readonly name: string;
  readonly nsfw: boolean;
}
export interface LeonardoListPlatformModelsResponse {
  readonly custom_models: readonly LeonardoPlatformModel[];
}
export interface LeonardoPollOptions {
  readonly maxAttempts: number;
  readonly intervalMs: number;
}
export interface LeonardoProviderError {
  readonly error: string;
  readonly path: string;
  readonly code: string;
}
