export type IdeogramRenderingSpeed = 'FLASH' | 'TURBO' | 'DEFAULT' | 'QUALITY';
export type IdeogramTransparentRenderingSpeed = Exclude<IdeogramRenderingSpeed, 'FLASH'>;
export type IdeogramMagicPrompt = 'AUTO' | 'ON' | 'OFF';
export type IdeogramStyleType = 'AUTO' | 'GENERAL' | 'REALISTIC' | 'DESIGN' | 'FICTION';
export type IdeogramUpscaleStyleType = IdeogramStyleType | 'RENDER_3D' | 'ANIME';
export type IdeogramUpscaleFactor = 'X1' | 'X2' | 'X4';

export type IdeogramV3AspectRatio =
  | '1x3'
  | '3x1'
  | '1x2'
  | '2x1'
  | '9x16'
  | '16x9'
  | '10x16'
  | '16x10'
  | '2x3'
  | '3x2'
  | '3x4'
  | '4x3'
  | '4x5'
  | '5x4'
  | '1x1';

export type IdeogramV3Resolution =
  | '512x1536'
  | '576x1408'
  | '576x1472'
  | '576x1536'
  | '640x1344'
  | '640x1408'
  | '640x1472'
  | '640x1536'
  | '704x1152'
  | '704x1216'
  | '704x1280'
  | '704x1344'
  | '704x1408'
  | '704x1472'
  | '736x1312'
  | '768x1088'
  | '768x1216'
  | '768x1280'
  | '768x1344'
  | '800x1280'
  | '832x960'
  | '832x1024'
  | '832x1088'
  | '832x1152'
  | '832x1216'
  | '832x1248'
  | '864x1152'
  | '896x960'
  | '896x1024'
  | '896x1088'
  | '896x1120'
  | '896x1152'
  | '960x832'
  | '960x896'
  | '960x1024'
  | '960x1088'
  | '1024x832'
  | '1024x896'
  | '1024x960'
  | '1024x1024'
  | '1088x768'
  | '1088x832'
  | '1088x896'
  | '1088x960'
  | '1120x896'
  | '1152x704'
  | '1152x832'
  | '1152x864'
  | '1152x896'
  | '1216x704'
  | '1216x768'
  | '1216x832'
  | '1248x832'
  | '1280x704'
  | '1280x768'
  | '1280x800'
  | '1312x736'
  | '1344x640'
  | '1344x704'
  | '1344x768'
  | '1408x576'
  | '1408x640'
  | '1408x704'
  | '1472x576'
  | '1472x640'
  | '1472x704'
  | '1536x512'
  | '1536x576'
  | '1536x640';

export type IdeogramV4Resolution =
  | '2048x2048'
  | '1440x2880'
  | '2880x1440'
  | '1664x2496'
  | '2496x1664'
  | '1792x2240'
  | '2240x1792'
  | '1440x2560'
  | '2560x1440'
  | '1600x2560'
  | '2560x1600'
  | '1728x2304'
  | '2304x1728'
  | '1296x3168'
  | '3168x1296'
  | '1152x2944'
  | '2944x1152'
  | '1248x3328'
  | '3328x1248'
  | '1280x3072'
  | '3072x1280'
  | '1024x3072'
  | '3072x1024';

export type IdeogramV3StylePreset =
  | '80S_ILLUSTRATION'
  | '90S_NOSTALGIA'
  | 'ABSTRACT_ORGANIC'
  | 'ANALOG_NOSTALGIA'
  | 'ART_BRUT'
  | 'ART_DECO'
  | 'ART_POSTER'
  | 'AURA'
  | 'AVANT_GARDE'
  | 'BAUHAUS'
  | 'BLUEPRINT'
  | 'BLURRY_MOTION'
  | 'BRIGHT_ART'
  | 'C4D_CARTOON'
  | 'CHILDRENS_BOOK'
  | 'COLLAGE'
  | 'COLORING_BOOK_I'
  | 'COLORING_BOOK_II'
  | 'CUBISM'
  | 'DARK_AURA'
  | 'DOODLE'
  | 'DOUBLE_EXPOSURE'
  | 'DRAMATIC_CINEMA'
  | 'EDITORIAL'
  | 'EMOTIONAL_MINIMAL'
  | 'ETHEREAL_PARTY'
  | 'EXPIRED_FILM'
  | 'FLAT_ART'
  | 'FLAT_VECTOR'
  | 'FOREST_REVERIE'
  | 'GEO_MINIMALIST'
  | 'GLASS_PRISM'
  | 'GOLDEN_HOUR'
  | 'GRAFFITI_I'
  | 'GRAFFITI_II'
  | 'HALFTONE_PRINT'
  | 'HIGH_CONTRAST'
  | 'HIPPIE_ERA'
  | 'ICONIC'
  | 'JAPANDI_FUSION'
  | 'JAZZY'
  | 'LONG_EXPOSURE'
  | 'MAGAZINE_EDITORIAL'
  | 'MINIMAL_ILLUSTRATION'
  | 'MIXED_MEDIA'
  | 'MONOCHROME'
  | 'NIGHTLIFE'
  | 'OIL_PAINTING'
  | 'OLD_CARTOONS'
  | 'PAINT_GESTURE'
  | 'POP_ART'
  | 'RETRO_ETCHING'
  | 'RIVIERA_POP'
  | 'SPOTLIGHT_80S'
  | 'STYLIZED_RED'
  | 'SURREAL_COLLAGE'
  | 'TRAVEL_POSTER'
  | 'VINTAGE_GEO'
  | 'VINTAGE_POSTER'
  | 'WATERCOLOR'
  | 'WEIRD'
  | 'WOODBLOCK_PRINT';

export type IdeogramPalettePreset =
  | 'EMBER'
  | 'FRESH'
  | 'JUNGLE'
  | 'MAGIC'
  | 'MELON'
  | 'MOSAIC'
  | 'PASTEL'
  | 'ULTRAMARINE';

export type IdeogramColorPalette =
  | { name: IdeogramPalettePreset; members?: never }
  | {
      name?: never;
      members: Array<{ color_hex: string; color_weight?: number }>;
    };

export interface IdeogramV4StyleDescription {
  aesthetics?: string;
  art_style?: string;
  lighting?: string;
  medium?: string;
  photo?: string;
}

export interface IdeogramV4ObjectElement {
  type: 'obj';
  bbox?: number[];
  desc: string;
}

export interface IdeogramV4TextElement {
  type: 'text';
  bbox?: number[];
  text: string;
  desc: string;
}

export interface IdeogramV4JsonPrompt {
  high_level_description: string;
  style_description?: IdeogramV4StyleDescription;
  compositional_deconstruction: {
    background: string;
    elements: Array<IdeogramV4ObjectElement | IdeogramV4TextElement>;
  };
}

interface IdeogramV4Options {
  resolution?: IdeogramV4Resolution;
  rendering_speed?: IdeogramRenderingSpeed;
  enable_copyright_detection?: boolean | null;
}

export type IdeogramGenerateV4Request = IdeogramV4Options &
  (
    | { text_prompt: string; json_prompt?: never }
    | { text_prompt?: never; json_prompt: IdeogramV4JsonPrompt }
  );

export interface IdeogramRemixV4Request extends IdeogramV4Options {
  image: Blob;
  text_prompt: string;
  image_weight?: number;
}

interface IdeogramV3StyleFields {
  color_palette?: IdeogramColorPalette;
  style_codes?: string[];
  style_preset?: IdeogramV3StylePreset;
  style_reference_images?: Blob[];
}

interface IdeogramV3CharacterFields {
  character_reference_images?: Blob[];
  character_reference_images_mask?: Blob[];
}

export interface IdeogramGenerateV3Request
  extends IdeogramV3StyleFields, IdeogramV3CharacterFields {
  prompt: string;
  seed?: number;
  resolution?: IdeogramV3Resolution;
  aspect_ratio?: IdeogramV3AspectRatio;
  rendering_speed?: IdeogramRenderingSpeed;
  magic_prompt?: IdeogramMagicPrompt;
  negative_prompt?: string;
  num_images?: number;
  style_type?: IdeogramStyleType;
  custom_model_uri?: string;
  enable_copyright_detection?: boolean | null;
}

export interface IdeogramGenerateTransparentV3Request {
  prompt: string;
  seed?: number;
  upscale_factor?: IdeogramUpscaleFactor;
  aspect_ratio?: IdeogramV3AspectRatio;
  rendering_speed?: IdeogramTransparentRenderingSpeed;
  magic_prompt?: IdeogramMagicPrompt;
  negative_prompt?: string;
  num_images?: number;
}

export interface IdeogramInpaintV3Request extends IdeogramV3StyleFields, IdeogramV3CharacterFields {
  image: Blob;
  mask: Blob;
  prompt: string;
  magic_prompt?: IdeogramMagicPrompt;
  num_images?: number;
  seed?: number;
  rendering_speed?: IdeogramRenderingSpeed;
  style_type?: IdeogramStyleType;
}

export interface IdeogramRemixV3Request extends IdeogramV3StyleFields, IdeogramV3CharacterFields {
  image: Blob;
  prompt: string;
  image_weight?: number;
  seed?: number;
  resolution?: IdeogramV3Resolution;
  aspect_ratio?: IdeogramV3AspectRatio;
  rendering_speed?: IdeogramRenderingSpeed;
  magic_prompt?: IdeogramMagicPrompt;
  negative_prompt?: string;
  num_images?: number;
  style_type?: IdeogramStyleType;
}

export interface IdeogramReframeV3Request extends IdeogramV3StyleFields {
  image: Blob;
  resolution: IdeogramV3Resolution;
  num_images?: number;
  seed?: number;
  rendering_speed?: IdeogramRenderingSpeed;
}

export interface IdeogramReplaceBackgroundV3Request extends IdeogramV3StyleFields {
  image: Blob;
  prompt: string;
  magic_prompt?: IdeogramMagicPrompt;
  num_images?: number;
  seed?: number;
  rendering_speed?: IdeogramRenderingSpeed;
}

export interface IdeogramRemoveBackgroundRequest {
  image: Blob;
}

export interface IdeogramLayerizeTextV3Request {
  image: Blob;
  prompt?: string;
  seed?: number;
}

export interface IdeogramEditWithPromptRequest {
  prompt: string;
  images?: Blob[];
  image_urls?: string[];
  num_images?: number;
  seed?: number;
  magic_prompt?: IdeogramMagicPrompt;
  resolution?: IdeogramV3Resolution;
  aspect_ratio?: IdeogramV3AspectRatio;
  transparent_background?: boolean;
}

export interface IdeogramUpscaleRequest {
  image_request: {
    prompt?: string;
    resemblance?: number;
    detail?: number;
    magic_prompt_option?: IdeogramMagicPrompt;
    num_images?: number;
    seed?: number;
  };
  image_file: Blob;
}

export interface IdeogramImageV4 {
  url?: string | null;
  prompt: string;
  resolution: IdeogramV4Resolution;
  is_image_safe: boolean;
  seed: number;
}

export interface IdeogramImageV3 {
  url?: string | null;
  prompt: string;
  resolution: IdeogramV3Resolution;
  upscaled_resolution?: string;
  is_image_safe: boolean;
  seed: number;
  style_type?: IdeogramStyleType;
}

export interface IdeogramImageResponseV4 {
  response_type?: 'url';
  created: string;
  data: IdeogramImageV4[];
}

export interface IdeogramImageResponseV3 {
  created: string;
  data: IdeogramImageV3[];
}

export interface IdeogramAsyncGenerationAccepted {
  generation_id: string;
}

export type IdeogramGenerationStatus =
  | { generation_id: string; status: 'pending' | 'failed'; created: string }
  | {
      generation_id: string;
      status: 'completed';
      created: string;
      response_type: 'url';
      data: Array<{
        url?: string | null;
        prompt: string;
        resolution: string;
        is_image_safe: boolean;
        seed: number;
      }>;
    };

export interface IdeogramRemoveBackgroundResponse {
  created: string;
  data: Array<{ url?: string | null; is_image_safe: boolean }>;
}

export interface IdeogramLayerizeTextResponse {
  base_image_url: string;
  original_image_url?: string | null;
  seed: number;
  [providerField: string]: unknown;
}

export interface IdeogramUpscaleImage {
  url?: string | null;
  prompt: string;
  resolution: string;
  upscaled_resolution?: string;
  is_image_safe: boolean;
  seed: number;
  style_type?: IdeogramUpscaleStyleType;
}

export interface IdeogramUpscaleResponse {
  request_id?: string;
  created: string;
  data?: IdeogramUpscaleImage[];
}

export interface IdeogramTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: FormData;
}

export interface IdeogramTransportResponse<T = unknown> {
  status: number;
  body: T;
}

export interface IdeogramTransport {
  request<T = unknown>(request: IdeogramTransportRequest): Promise<IdeogramTransportResponse<T>>;
}
