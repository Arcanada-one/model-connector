import { z } from 'zod';

const languageSelection = {
  languageCode: z.string().min(1).optional(),
  identifyLanguage: z.boolean().optional(),
  identifyMultipleLanguages: z.boolean().optional(),
  languageOptions: z.array(z.string().min(1)).optional(),
};

interface LanguageSelection {
  languageCode?: string;
  identifyLanguage?: boolean;
  identifyMultipleLanguages?: boolean;
}

const exactlyOneLanguage = (value: LanguageSelection, context: z.RefinementCtx) => {
  const selected = [
    value.languageCode !== undefined,
    value.identifyLanguage === true,
    value.identifyMultipleLanguages === true,
  ].filter(Boolean).length;
  if (selected !== 1) {
    context.addIssue({
      code: 'custom',
      message:
        'exactly one of languageCode, identifyLanguage, or identifyMultipleLanguages is required',
    });
  }
};

export const streamTranscriptionRequestSchema = z
  .object({
    protocol: z.enum(['http2', 'websocket']),
    ...languageSelection,
    mediaEncoding: z.enum(['pcm', 'ogg-opus', 'flac']),
    sampleRateHertz: z.number().int().min(8000).max(48000),
    sessionId: z.string().min(1).max(36).optional(),
    vocabularyName: z.string().min(1).max(200).optional(),
    vocabularyNames: z.array(z.string().min(1)).optional(),
    vocabularyFilterName: z.string().min(1).max(200).optional(),
    vocabularyFilterNames: z.array(z.string().min(1)).optional(),
    enableChannelIdentification: z.boolean().optional(),
    numberOfChannels: z.literal(2).optional(),
    enablePartialResultsStabilization: z.boolean().optional(),
    partialResultsStability: z.enum(['low', 'medium', 'high']).optional(),
    contentIdentificationType: z.literal('PII').optional(),
    contentRedactionType: z.literal('PII').optional(),
    piiEntityTypes: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, context) => {
    exactlyOneLanguage(value, context);
    if (value.enableChannelIdentification && value.numberOfChannels === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'numberOfChannels is required when enableChannelIdentification is true',
      });
    }
    if (value.contentIdentificationType && value.contentRedactionType) {
      context.addIssue({
        code: 'custom',
        message: 'Content identification and Content redaction are mutually exclusive',
      });
    }
  });

export const transcribeRequestSchema = streamTranscriptionRequestSchema.and(
  z.object({ audio: z.instanceof(Uint8Array).refine((audio) => audio.length > 0) }),
);

export const startTranscriptionJobRequestSchema = z
  .object({
    transcriptionJobName: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[0-9A-Za-z._-]+$/),
    mediaFileUri: z.string().regex(/^s3:\/\/[^/]+\/.+/),
    mediaFormat: z.enum(['amr', 'flac', 'm4a', 'mp3', 'mp4', 'ogg', 'webm', 'wav']).optional(),
    mediaSampleRateHertz: z.number().int().min(8000).max(48000).optional(),
    ...languageSelection,
    outputBucketName: z
      .string()
      .regex(/^[a-z0-9][.\-a-z0-9]{1,61}[a-z0-9]$/)
      .optional(),
    outputKey: z.string().max(1024).optional(),
    outputEncryptionKmsKeyId: z.string().min(1).max(2048).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    subtitles: z.record(z.string(), z.unknown()).optional(),
    tags: z
      .array(z.object({ Key: z.string(), Value: z.string() }).passthrough())
      .max(200)
      .optional(),
  })
  .superRefine(exactlyOneLanguage);

export const transcriptionJobNameRequestSchema = z.object({
  transcriptionJobName: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[0-9A-Za-z._-]+$/),
});

export const transcriptionJobListRequestSchema = z.object({
  jobNameContains: z.string().min(1).max(200).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
  nextToken: z.string().min(1).max(8192).optional(),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'FAILED', 'COMPLETED']).optional(),
});

export const pollyEngineSchema = z.enum(['standard', 'neural', 'long-form', 'generative']);
export const pollyOutputFormatSchema = z.enum([
  'json',
  'mp3',
  'ogg_opus',
  'ogg_vorbis',
  'pcm',
  'mulaw',
  'alaw',
]);
const speechMarkSchema = z.enum(['sentence', 'ssml', 'viseme', 'word']);

const synchronousSampleRates: Record<string, readonly string[]> = {
  json: [],
  mp3: ['8000', '16000', '22050', '24000', '44100', '48000'],
  ogg_vorbis: ['8000', '16000', '22050', '24000', '44100', '48000'],
  ogg_opus: ['48000'],
  pcm: ['8000', '16000'],
  mulaw: ['8000'],
  alaw: ['8000'],
};

const asynchronousSampleRates: Record<string, readonly string[]> = {
  ...synchronousSampleRates,
  mp3: ['8000', '16000', '22050', '24000'],
  ogg_vorbis: ['8000', '16000', '22050', '24000'],
};

const validatePollySynthesis = (
  value: {
    text: string;
    textType?: 'ssml' | 'text';
    outputFormat: string;
    sampleRate?: string;
    speechMarkTypes?: string[];
    lexiconNames?: string[];
  },
  context: z.RefinementCtx,
  billedLimit: number,
  totalLimit: number,
  sampleRates: Record<string, readonly string[]>,
) => {
  const billed =
    value.textType === 'ssml' ? value.text.replace(/<[^>]*>/g, '').length : value.text.length;
  if (value.text.length > totalLimit || billed > billedLimit) {
    context.addIssue({
      code: 'custom',
      message: `text exceeds ${billedLimit} billed or ${totalLimit} total characters`,
    });
  }
  if (value.sampleRate && !sampleRates[value.outputFormat]?.includes(value.sampleRate)) {
    context.addIssue({
      code: 'custom',
      message: `sampleRate is not supported for ${value.outputFormat}`,
    });
  }
  if (value.speechMarkTypes?.length && value.outputFormat !== 'json') {
    context.addIssue({
      code: 'custom',
      message: 'speechMarkTypes require json outputFormat',
    });
  }
  if (value.outputFormat === 'json' && !value.speechMarkTypes?.length) {
    context.addIssue({
      code: 'custom',
      message: 'json outputFormat requires speechMarkTypes',
    });
  }
};

const pollySynthesisShape = {
  engine: pollyEngineSchema.optional(),
  languageCode: z.string().min(1).optional(),
  lexiconNames: z
    .array(z.string().regex(/^[0-9A-Za-z]{1,20}$/))
    .max(5)
    .optional(),
  outputFormat: pollyOutputFormatSchema,
  sampleRate: z.string().optional(),
  speechMarkTypes: z.array(speechMarkSchema).max(4).optional(),
  text: z.string().min(1),
  textType: z.enum(['ssml', 'text']).optional(),
  voiceId: z.string().min(1),
};

export const synthesizeSpeechRequestSchema = z
  .object(pollySynthesisShape)
  .superRefine((value, context) =>
    validatePollySynthesis(value, context, 3000, 6000, synchronousSampleRates),
  );

export const startSpeechSynthesisTaskRequestSchema = z
  .object({
    ...pollySynthesisShape,
    outputS3BucketName: z.string().regex(/^[a-z0-9][.\-a-z0-9]{1,61}[a-z0-9]$/),
    outputS3KeyPrefix: z.string().max(800).optional(),
    snsTopicArn: z.string().startsWith('arn:').optional(),
  })
  .superRefine((value, context) =>
    validatePollySynthesis(value, context, 100000, 200000, asynchronousSampleRates),
  );

export const speechSynthesisTaskIdRequestSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
});

export const speechSynthesisTaskListRequestSchema = z.object({
  maxResults: z.number().int().min(1).max(100).optional(),
  nextToken: z.string().min(1).max(4096).optional(),
  status: z.enum(['scheduled', 'inProgress', 'completed', 'failed']).optional(),
});

export const describeVoicesRequestSchema = z.object({
  engine: pollyEngineSchema.optional(),
  includeAdditionalLanguageCodes: z.boolean().optional(),
  languageCode: z.string().min(1).optional(),
  nextToken: z.string().min(1).max(4096).optional(),
});

export const listLexiconsRequestSchema = z.object({
  nextToken: z.string().min(1).max(4096).optional(),
});

export const getLexiconRequestSchema = z.object({
  lexiconName: z.string().regex(/^[0-9A-Za-z]{1,20}$/),
});

const transcriptionJobSchema = z
  .object({
    TranscriptionJobName: z.string(),
    TranscriptionJobStatus: z.enum(['QUEUED', 'IN_PROGRESS', 'FAILED', 'COMPLETED']),
  })
  .passthrough();

export const transcriptionJobResponseSchema = z
  .object({ TranscriptionJob: transcriptionJobSchema })
  .passthrough();
export const transcriptionJobListResponseSchema = z
  .object({
    NextToken: z.string().optional(),
    Status: z.enum(['QUEUED', 'IN_PROGRESS', 'FAILED', 'COMPLETED']).optional(),
    TranscriptionJobSummaries: z.array(
      z
        .object({
          TranscriptionJobName: z.string(),
          TranscriptionJobStatus: z.enum(['QUEUED', 'IN_PROGRESS', 'FAILED', 'COMPLETED']),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const synthesisTaskSchema = z
  .object({
    TaskId: z.string(),
    TaskStatus: z.enum(['scheduled', 'inProgress', 'completed', 'failed']),
  })
  .passthrough();
export const speechSynthesisTaskResponseSchema = z
  .object({ SynthesisTask: synthesisTaskSchema })
  .passthrough();
export const speechSynthesisTaskListResponseSchema = z
  .object({
    NextToken: z.string().optional(),
    SynthesisTasks: z.array(synthesisTaskSchema),
  })
  .passthrough();

export const describeVoicesResponseSchema = z
  .object({
    NextToken: z.string().optional(),
    Voices: z.array(
      z
        .object({
          Id: z.string(),
          Name: z.string(),
          Gender: z.string(),
          LanguageCode: z.string(),
          LanguageName: z.string(),
          AdditionalLanguageCodes: z.array(z.string()).optional(),
          SupportedEngines: z.array(pollyEngineSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const lexiconAttributesSchema = z
  .object({
    Alphabet: z.string(),
    LanguageCode: z.string(),
    LastModified: z.number(),
    LexemesCount: z.number(),
    LexiconArn: z.string(),
    Size: z.number(),
  })
  .passthrough();
export const listLexiconsResponseSchema = z
  .object({
    NextToken: z.string().optional(),
    Lexicons: z.array(
      z
        .object({
          Name: z.string(),
          Attributes: lexiconAttributesSchema,
        })
        .passthrough(),
    ),
  })
  .passthrough();
export const getLexiconResponseSchema = z
  .object({
    Lexicon: z.object({ Name: z.string(), Content: z.string() }).passthrough(),
    LexiconAttributes: lexiconAttributesSchema,
  })
  .passthrough();

export const transcribeStreamEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('transcript'),
      requestId: z.string().optional(),
      Transcript: z
        .object({
          Results: z.array(
            z
              .object({
                ResultId: z.string().optional(),
                IsPartial: z.boolean(),
                StartTime: z.number().optional(),
                EndTime: z.number().optional(),
                Alternatives: z.array(z.object({ Transcript: z.string() }).passthrough()),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('exception'),
      code: z.string(),
      message: z.string(),
      requestId: z.string().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('end'), requestId: z.string().optional() }).passthrough(),
]);

export type StreamTranscriptionRequest = z.infer<typeof streamTranscriptionRequestSchema>;
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;
export type StartTranscriptionJobRequest = z.infer<typeof startTranscriptionJobRequestSchema>;
export type SynthesizeSpeechRequest = z.infer<typeof synthesizeSpeechRequestSchema>;
export type StartSpeechSynthesisTaskRequest = z.infer<typeof startSpeechSynthesisTaskRequestSchema>;
