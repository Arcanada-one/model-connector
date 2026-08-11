export const DEEPGRAM_VOICE_AGENT_CAPABILITIES = {
  provider: 'deepgram-voice-agent',
  endpoint: 'wss://agent.deepgram.com/v1/agent/converse',
  authentication: ['token', 'bearer', 'sec-websocket-protocol'],
  modalities: ['audio-input', 'audio-output', 'text'],
  transport: 'full-duplex-websocket',
} as const;
