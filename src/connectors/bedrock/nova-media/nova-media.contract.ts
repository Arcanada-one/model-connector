import type { AwsPartition } from './nova-media.types';

export const BEDROCK_NOVA_MEDIA_SIGNER = Symbol('BEDROCK_NOVA_MEDIA_SIGNER');
export const BEDROCK_NOVA_MEDIA_TRANSPORT = Symbol('BEDROCK_NOVA_MEDIA_TRANSPORT');

export const CANVAS_MODEL = 'amazon.nova-canvas-v1:0' as const;
export const REEL_MODELS = ['amazon.nova-reel-v1:0', 'amazon.nova-reel-v1:1'] as const;

export const CANVAS_REGIONS = ['us-east-1', 'eu-west-1', 'ap-northeast-1'] as const;
export const REEL_V1_REGIONS = CANVAS_REGIONS;
export const REEL_V1_1_REGIONS = ['us-east-1'] as const;

const PARTITION_DNS_SUFFIX: Record<AwsPartition, string> = {
  aws: 'amazonaws.com',
  'aws-cn': 'amazonaws.com.cn',
  'aws-us-gov': 'amazonaws.com',
};

export function bedrockRuntimeEndpoint(region: string, partition: AwsPartition = 'aws'): string {
  return `https://bedrock-runtime.${region}.${PARTITION_DNS_SUFFIX[partition]}`;
}

export const NOVA_MEDIA_MODEL_META = [
  { id: CANVAS_MODEL, modality: 'image_generation' as const },
  { id: REEL_MODELS[0], modality: 'video' as const },
  { id: REEL_MODELS[1], modality: 'video' as const },
] as const;
