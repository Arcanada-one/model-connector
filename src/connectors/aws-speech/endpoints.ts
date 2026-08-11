export type AwsPartitionId = 'aws' | 'aws-us-gov' | 'aws-cn';

export interface AwsPartitionDescriptor {
  id: string;
  dnsSuffix: string;
}

export type AwsPartition = AwsPartitionId | AwsPartitionDescriptor;

export interface AwsSpeechEndpoints {
  transcribeBatch: string;
  transcribeStreaming: string;
  transcribeWebSocket: string;
  polly: string;
}

const PARTITIONS: Record<AwsPartitionId, AwsPartitionDescriptor> = {
  aws: { id: 'aws', dnsSuffix: 'amazonaws.com' },
  'aws-us-gov': { id: 'aws-us-gov', dnsSuffix: 'amazonaws.com' },
  'aws-cn': { id: 'aws-cn', dnsSuffix: 'amazonaws.com.cn' },
};

const DNS_LABELS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const REGION = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function resolveAwsSpeechEndpoints(input: {
  partition: AwsPartition;
  region: string;
}): AwsSpeechEndpoints {
  if (!REGION.test(input.region)) {
    throw new Error('region must be a valid AWS region identifier');
  }

  const descriptor =
    typeof input.partition === 'string' ? PARTITIONS[input.partition] : input.partition;
  if (!descriptor || !DNS_LABELS.test(descriptor.dnsSuffix)) {
    throw new Error('dnsSuffix must contain DNS labels only');
  }

  const suffix = `${input.region}.${descriptor.dnsSuffix}`;
  const streamingHost = `transcribestreaming.${suffix}`;
  return {
    transcribeBatch: `https://transcribe.${suffix}/transcribe`,
    transcribeStreaming: `https://${streamingHost}/stream-transcription`,
    transcribeWebSocket: `wss://${streamingHost}:8443/stream-transcription-websocket`,
    polly: `https://polly.${suffix}`,
  };
}
