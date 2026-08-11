export const AZURE_SPEECH_CAPABILITIES = {
  provider: 'azure-speech',
  operationFamilies: [
    'speech-to-text-fast',
    'speech-to-text-batch',
    'speech-to-text-streaming',
    'text-to-speech',
    'voice-discovery',
  ],
  speechToTextApiVersion: '2025-10-15',
  fast: {
    maxBytesExclusive: 250_000_000,
    maxDurationSecondsExclusive: 7_200,
    documentationBoundary: 'operation-reference-stricter-than-quota-page',
  },
  batch: {
    states: ['NotStarted', 'Running', 'Succeeded', 'Failed'],
    maxContentUrls: 1_000,
    minimumPollingIntervalMs: 60_000,
    cancellation: 'delete-resource-no-separate-cancel',
    remoteContentLimits: {
      quotaMaxAudioInput: '1 GB',
      operationReferenceMaxContainer: '5 GB',
      operationReferenceMaxBlob: '2.5 GB',
      maxBlobsPerContainer: 10_000,
      enforcement: 'provider',
      documentationDrift: true,
    },
  },
  streaming: {
    transportBoundary: 'injected-no-frame-claims',
    supportedAudioContentTypes: [
      'audio/wav; codecs=audio/pcm; samplerate=16000',
      'audio/ogg; codecs=opus',
    ],
    generalSessionDurationLimit: 'not-documented',
  },
  textToSpeech: {
    maxOutputMinutes: 10,
    maxDistinctVoiceAndAudioTags: 50,
    tagLimitEnforcement: 'provider',
  },
  voiceDiscovery: {
    staticCatalogue: false,
  },
} as const;
