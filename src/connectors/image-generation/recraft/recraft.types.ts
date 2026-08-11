export type RecraftRasterModel =
  | 'recraftv4_1'
  | 'recraftv4_1_pro'
  | 'recraftv4_1_utility'
  | 'recraftv4_1_utility_pro'
  | 'recraftv4'
  | 'recraftv4_pro'
  | 'recraftv3'
  | 'recraftv2';

export type RecraftVectorModel =
  | 'recraftv4_1_vector'
  | 'recraftv4_1_pro_vector'
  | 'recraftv4_1_utility_vector'
  | 'recraftv4_1_utility_pro_vector'
  | 'recraftv4_vector'
  | 'recraftv4_pro_vector'
  | 'recraftv3_vector'
  | 'recraftv2_vector';

export type RecraftImageToImageModel = Exclude<
  RecraftRasterModel | RecraftVectorModel,
  'recraftv2' | 'recraftv2_vector'
>;

export type RecraftEditModel = 'recraftv3' | 'recraftv3_vector';
export type RecraftImageFormat = 'webp' | 'png';
export type RecraftResponseFormat = 'url' | 'b64_json';
export type RecraftCreativity = 'simple' | 'standard' | 'eccentric';
export type RecraftImageStyle =
  | 'any'
  | 'digital_illustration'
  | 'icon'
  | 'realistic_image'
  | 'vector_illustration'
  | 'logo_raster';
export type RecraftMixPolicy = 'PaletteMatch' | 'MaxWeight';
export type RecraftToggle = 'on' | 'off';
export type RecraftShapeStacking = 'cut_out' | 'hierarchical';
export type RecraftUpscaleMode = 'upscale4mp' | 'upscale16mp';
export type RecraftBilling = 'api' | 'subscription';
export type RecraftGenerationModel = RecraftRasterModel | RecraftVectorModel;
export type RecraftExploreModel =
  | 'recraftv4'
  | 'recraftv4_vector'
  | 'recraftv4_pro'
  | 'recraftv4_pro_vector';

export type RecraftImageSize =
  | '1024x1024'
  | '1365x1024'
  | '1024x1365'
  | '1536x1024'
  | '1024x1536'
  | '1820x1024'
  | '1024x1820'
  | '1024x2048'
  | '2048x1024'
  | '1434x1024'
  | '1024x1434'
  | '1024x1280'
  | '1280x1024'
  | '1024x1707'
  | '1707x1024'
  | '1216x896'
  | '896x1216'
  | '1280x832'
  | '832x1280'
  | '1152x896'
  | '896x1152'
  | '1280x896'
  | '896x1280'
  | '832x1344'
  | '768x1344'
  | '1344x768'
  | '768x1536'
  | '1536x768'
  | '2048x2048'
  | '2432x1792'
  | '1792x2432'
  | '2560x1664'
  | '1664x2560'
  | '2304x1792'
  | '1792x2304'
  | '2560x1792'
  | '1792x2560'
  | '1664x2688'
  | '1536x2688'
  | '2688x1536'
  | '1536x3072'
  | '3072x1536'
  | '1:1'
  | '2:1'
  | '1:2'
  | '3:2'
  | '2:3'
  | '4:3'
  | '3:4'
  | '5:4'
  | '4:5'
  | '6:10'
  | '14:10'
  | '10:14'
  | '16:9'
  | '9:16';

export type RecraftImageSubStyle =
  | '2d_art_poster'
  | '3d'
  | '80s'
  | 'glow'
  | 'grain'
  | 'hand_drawn'
  | 'infantile_sketch'
  | 'kawaii'
  | 'pixel_art'
  | 'psychedelic'
  | 'seamless'
  | 'voxel'
  | 'watercolor'
  | 'broken_line'
  | 'colored_outline'
  | 'colored_shapes'
  | 'colored_shapes_gradient'
  | 'doodle_fill'
  | 'doodle_offset_fill'
  | 'offset_fill'
  | 'outline'
  | 'outline_gradient'
  | 'cartoon'
  | 'doodle_line_art'
  | 'engraving'
  | 'flat_2'
  | 'line_art'
  | 'linocut'
  | 'b_and_w'
  | 'enterprise'
  | 'hard_flash'
  | 'hdr'
  | 'motion_blur'
  | 'natural_light'
  | 'studio_portrait'
  | 'line_circuit'
  | '2d_art_poster_2'
  | 'engraving_color'
  | 'hand_drawn_outline'
  | 'handmade_3d'
  | 'plastic'
  | 'pictogram'
  | 'antiquarian'
  | 'bold_fantasy'
  | 'child_book'
  | 'cover'
  | 'crosshatch'
  | 'digital_engraving'
  | 'expressionism'
  | 'freehand_details'
  | 'grain_20'
  | 'graphic_intensity'
  | 'hard_comics'
  | 'long_shadow'
  | 'modern_folk'
  | 'multicolor'
  | 'neon_calm'
  | 'noir'
  | 'nostalgic_pastel'
  | 'outline_details'
  | 'pastel_gradient'
  | 'pastel_sketch'
  | 'pop_art'
  | 'pop_renaissance'
  | 'street_art'
  | 'tablet_sketch'
  | 'urban_glow'
  | 'urban_sketching'
  | 'young_adult_book'
  | 'young_adult_book_2'
  | 'evening_light'
  | 'faded_nostalgia'
  | 'forest_life'
  | 'mystic_naturalism'
  | 'natural_tones'
  | 'organic_calm'
  | 'real_life_glow'
  | 'retro_realism'
  | 'retro_snapshot'
  | 'urban_drama'
  | 'village_realism'
  | 'warm_folk'
  | 'bold_stroke'
  | 'chemistry'
  | 'colored_stencil'
  | 'cosmics'
  | 'cutout'
  | 'depressive'
  | 'editorial'
  | 'emotional_flat'
  | 'marker_outline'
  | 'mosaic'
  | 'naivector'
  | 'roundish_flat'
  | 'segmented_colors'
  | 'sharp_contrast'
  | 'thin'
  | 'vector_photo'
  | 'vivid_shapes'
  | 'emblem_graffiti'
  | 'emblem_pop_art'
  | 'emblem_punk'
  | 'emblem_stamp'
  | 'emblem_vintage';

export interface RecraftImageColor {
  rgb?: number[];
  std?: number[];
  weight?: number;
}

export interface RecraftUserControls {
  artistic_level?: number;
  background_color?: RecraftImageColor;
  colors?: RecraftImageColor[];
  no_text?: boolean;
}

export interface RecraftTextLayoutItem {
  text: string;
  bbox: number[][];
}

export interface RecraftPalette {
  colors: RecraftImageColor[];
  background_color?: RecraftImageColor;
}

export interface RecraftBinaryAsset {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface RecraftImage {
  image_id: string;
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
  features?: RecraftImageFeatures;
}

export interface RecraftImageFeatures {
  nsfw_score?: number;
}

export interface GenerateImageResponse {
  created: number;
  credits: number;
  data: RecraftImage[];
}

export interface ProcessImageResponse {
  created: number;
  credits: number;
  image: RecraftImage;
}

export interface CreateStyleResponse {
  id: string;
  style: RecraftImageStyle;
  substyle?: RecraftImageSubStyle;
  creation_time: string;
  is_private: boolean;
  credits: number;
}

export interface RecraftStyle {
  id: string;
  style: RecraftImageStyle;
  substyle?: RecraftImageSubStyle;
  creation_time: string;
  is_private: boolean;
}

export interface BasicStyle {
  style_id: string;
  style: string;
  model: RecraftGenerationModel;
}

export interface ListStylesResponse {
  styles: RecraftStyle[];
}

export interface ListBasicStylesResponse {
  styles: BasicStyle[];
}

export type DeleteStyleResponse = Record<string, unknown>;

interface RecraftBillingOptions {
  billing?: RecraftBilling;
}

interface RecraftSharedOptionsBase extends RecraftBillingOptions {
  block_nsfw?: boolean;
  calculate_features?: boolean;
  controls?: RecraftUserControls;
  creativity?: RecraftCreativity;
  expire?: boolean;
  image_format?: RecraftImageFormat;
  n?: number;
  negative_prompt?: string;
  random_seed?: number;
  response_format?: RecraftResponseFormat;
  substyle?: RecraftImageSubStyle;
  text_layout?: RecraftTextLayoutItem[];
}

type RecraftStyleSelection =
  | { style?: string; style_id?: never }
  | { style?: never; style_id?: string };

type RecraftSharedOptions = RecraftSharedOptionsBase & RecraftStyleSelection;

type RecraftGenerationOptions = RecraftSharedOptions & {
  prompt: string;
  size?: RecraftImageSize;
  upscale?: RecraftUpscaleMode;
};

export type GenerateRasterRequest = RecraftGenerationOptions & {
  model?: RecraftRasterModel;
};

export type GenerateVectorRequest = RecraftGenerationOptions & {
  model?: RecraftVectorModel;
};

export type GenerateRequest = RecraftGenerationOptions & {
  model?: RecraftGenerationModel;
};

type RecraftTransformOptions = RecraftSharedOptions & {
  prompt: string;
};

interface RecraftJsonImageInput {
  mode: 'json';
  image_url: string;
}

interface RecraftMultipartImageInput {
  mode: 'multipart';
  image: RecraftBinaryAsset;
}

interface RecraftJsonMaskInput extends RecraftJsonImageInput {
  mask_url: string;
}

interface RecraftMultipartMaskInput extends RecraftMultipartImageInput {
  mask: RecraftBinaryAsset;
}

type RecraftImageToImageOptions = RecraftTransformOptions & {
  strength: number;
  model?: RecraftImageToImageModel;
};

export type ImageToImageRequest = RecraftImageToImageOptions &
  (RecraftJsonImageInput | RecraftMultipartImageInput);

type RecraftEditOptions = RecraftTransformOptions & {
  model?: RecraftEditModel;
};

export type InpaintRequest = RecraftEditOptions &
  (RecraftJsonMaskInput | RecraftMultipartMaskInput);

interface RecraftOutpaintFields {
  expand_bottom?: number;
  expand_left?: number;
  expand_right?: number;
  expand_top?: number;
  size?: RecraftImageSize;
  zoom_out_percentage?: number;
}

type RecraftPixelExpansion =
  | { expand_bottom: number }
  | { expand_left: number }
  | { expand_right: number }
  | { expand_top: number };

type RecraftOutpaintExpansion =
  | ({
      size: RecraftImageSize;
      expand_bottom?: never;
      expand_left?: never;
      expand_right?: never;
      expand_top?: never;
    } & Pick<RecraftOutpaintFields, 'zoom_out_percentage'>)
  | ({ size?: never; zoom_out_percentage: number } & Omit<
      RecraftOutpaintFields,
      'size' | 'zoom_out_percentage'
    >)
  | ({ size?: never } & RecraftPixelExpansion & Omit<RecraftOutpaintFields, 'size'>);

export type RecraftOutpaintOptions = RecraftEditOptions & RecraftOutpaintExpansion;

export type OutpaintRequest = RecraftOutpaintOptions &
  (RecraftJsonImageInput | RecraftMultipartImageInput);

export type ReplaceBackgroundRequest = RecraftEditOptions &
  (RecraftJsonImageInput | RecraftMultipartImageInput);

export type GenerateBackgroundRequest = RecraftEditOptions &
  (RecraftJsonMaskInput | RecraftMultipartMaskInput);

interface RecraftProcessOptions extends RecraftBillingOptions {
  expire?: boolean;
  image_format?: RecraftImageFormat;
  response_format?: RecraftResponseFormat;
  upscale?: RecraftUpscaleMode;
}

export type RecraftProcessRequest = RecraftProcessOptions &
  (RecraftJsonImageInput | RecraftMultipartImageInput);

export type RemoveBackgroundRequest = RecraftProcessRequest;

export type EraseRegionRequest = RecraftProcessOptions &
  (RecraftJsonMaskInput | RecraftMultipartMaskInput);

interface RecraftVariateOptions extends RecraftBillingOptions {
  size: RecraftImageSize;
  expire?: boolean;
  image_format?: RecraftImageFormat;
  model?: RecraftGenerationModel;
  n?: number;
  random_seed?: number;
  response_format?: RecraftResponseFormat;
}

export type VariateImageRequest = RecraftVariateOptions &
  (RecraftJsonImageInput | RecraftMultipartImageInput);

export type ExploreRequest = RecraftStyleSelection &
  RecraftBillingOptions & {
    prompt: string;
    block_nsfw?: boolean;
    controls?: RecraftUserControls;
    expire?: boolean;
    image_format?: RecraftImageFormat;
    model?: RecraftExploreModel;
    response_format?: RecraftResponseFormat;
    size?: RecraftImageSize;
    substyle?: RecraftImageSubStyle;
  };

export interface ExploreSimilarRequest extends RecraftBillingOptions {
  source_image_id: string;
  similarity: number;
  block_nsfw?: boolean;
  expire?: boolean;
  image_format?: RecraftImageFormat;
  response_format?: RecraftResponseFormat;
}

export type CrispUpscaleRequest = RecraftProcessRequest;
export type CreativeUpscaleRequest = RecraftProcessRequest;

export interface RecraftVectorizeOptions extends RecraftProcessOptions {
  color_reduction?: RecraftToggle;
  limit_num_shapes?: RecraftToggle;
  max_num_shapes?: number;
  return_gradients?: RecraftToggle;
  shape_stacking?: RecraftShapeStacking;
  small_shape_filter?: RecraftToggle;
  strict_color_palette?: number[][];
  svg_compression?: RecraftToggle;
}

export type VectorizeRequest = RecraftVectorizeOptions &
  (RecraftJsonImageInput | RecraftMultipartImageInput);

interface RecraftCreateStyleOptions extends RecraftBillingOptions {
  style: RecraftImageStyle;
  image_weights?: number[];
  mix_policy?: RecraftMixPolicy;
  model?: RecraftEditModel;
  palette?: RecraftPalette;
  private?: boolean;
  prompt?: string;
  source_style_weights?: number[];
}

interface RecraftCreateStyleJsonInput {
  mode: 'json';
  image_urls: string[];
  source_styles?: string[];
}

interface RecraftCreateStyleMultipartInput {
  mode: 'multipart';
  files: RecraftBinaryAsset[];
  source_styles?: string[];
}

interface RecraftCreateStyleSourceInput {
  mode: 'json';
  image_urls?: never;
  source_styles: [string, ...string[]];
}

export type CreateStyleRequest = RecraftCreateStyleOptions &
  (RecraftCreateStyleJsonInput | RecraftCreateStyleMultipartInput | RecraftCreateStyleSourceInput);
