export const SETTINGS = {
  type: 'Settings',
  audio: {
    input: { encoding: 'linear16', sample_rate: 16000 },
    output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
  },
  agent: {
    listen: { provider: { type: 'deepgram', model: 'nova-3' } },
    think: { provider: { type: 'open_ai', model: 'gpt-4o-mini' } },
    speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
  },
} as const;

export const SERVER_MESSAGES = [
  { type: 'Welcome', request_id: 'request-1' },
  { type: 'SettingsApplied' },
  { type: 'ListenUpdated' },
  { type: 'ThinkUpdated' },
  { type: 'SpeakUpdated' },
  { type: 'PromptUpdated' },
  { type: 'InjectionRefused', reason: 'user_speaking' },
  { type: 'ConversationText', role: 'user', content: 'Hello' },
  { type: 'UserStartedSpeaking' },
  { type: 'AgentThinking' },
  { type: 'FunctionCallRequest', functions: [] },
  { type: 'FunctionCallResponse', functions: [] },
  { type: 'AgentStartedSpeaking' },
  { type: 'AgentAudioDone' },
  { type: 'Warning', code: 'PROMPT_TOO_LONG', description: 'truncated' },
  { type: 'History', history: [] },
] as const;
