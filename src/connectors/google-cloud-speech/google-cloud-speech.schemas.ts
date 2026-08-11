import { z } from 'zod';

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const googleRpcStatusSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    details: z.array(jsonObjectSchema).optional(),
  })
  .passthrough();

export const googleLongRunningOperationSchema = z
  .object({
    name: z.string().min(1),
    metadata: jsonObjectSchema.optional(),
    done: z.boolean().optional(),
    error: googleRpcStatusSchema.optional(),
    response: jsonObjectSchema.optional(),
  })
  .passthrough()
  .superRefine((operation, context) => {
    const hasError = operation.error !== undefined;
    const hasResponse = operation.response !== undefined;
    if (operation.done === true && hasError === hasResponse) {
      context.addIssue({
        code: 'custom',
        message: 'A completed operation must contain exactly one of error or response',
      });
    }
    if (operation.done !== true && (hasError || hasResponse)) {
      context.addIssue({
        code: 'custom',
        message: 'An incomplete operation cannot contain error or response',
      });
    }
  });

export const googleApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        status: z.string().optional(),
        details: z.array(jsonObjectSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const speechRecognitionAlternativeSchema = z
  .object({
    transcript: z.string().optional(),
    confidence: z.number().optional(),
  })
  .passthrough();

const speechRecognitionResultSchema = z
  .object({
    alternatives: z.array(speechRecognitionAlternativeSchema).optional(),
    languageCode: z.string().optional(),
  })
  .passthrough();

export const recognizeResponseSchema = z
  .object({
    results: z.array(speechRecognitionResultSchema).optional(),
  })
  .passthrough();

export const synthesizeSpeechResponseSchema = z
  .object({
    audioContent: z.string(),
  })
  .passthrough();

export const listVoicesResponseSchema = z
  .object({
    voices: z
      .array(
        z
          .object({
            languageCodes: z.array(z.string()),
            name: z.string(),
            ssmlGender: z.string(),
            naturalSampleRateHertz: z.number().int(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const streamingSynthesizeResponseSchema = synthesizeSpeechResponseSchema;
