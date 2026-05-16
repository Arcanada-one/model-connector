import type { z } from 'zod';
import { deepgramListenResponseSchema } from './deepgram.schema';
import { assemblyAiTranscriptResponseSchema } from './assemblyai.schema';
import { openAiTranscriptionResponseSchema } from './openai.schema';

export { deepgramListenResponseSchema } from './deepgram.schema';
export {
  assemblyAiTranscriptResponseSchema,
  assemblyAiUploadResponseSchema,
} from './assemblyai.schema';
export { openAiTranscriptionResponseSchema } from './openai.schema';

/**
 * CONN-0103 — registry of provider-name → Zod schema for outbound STT
 * responses. Consumed by `SttRouterService.detectDrift()` after a
 * provider returns 200 to confirm the payload matches the captured
 * fixture shape; mismatch → cascade.
 */
export const STT_RESPONSE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  deepgram: deepgramListenResponseSchema,
  assemblyai: assemblyAiTranscriptResponseSchema,
  openai: openAiTranscriptionResponseSchema,
};

export const STT_RESPONSE_SCHEMAS_TOKEN = 'STT_RESPONSE_SCHEMAS';
