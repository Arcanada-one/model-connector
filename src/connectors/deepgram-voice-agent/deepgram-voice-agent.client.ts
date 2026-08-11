export type DeepgramVoiceAgentAuth = {
  type: 'token' | 'bearer' | 'subprotocol';
  credential: string;
};

export type DeepgramVoiceAgentAuthOptions =
  | { authorization: string }
  | { protocols: [string, string] };

export function buildDeepgramVoiceAgentAuth(
  auth: DeepgramVoiceAgentAuth,
): DeepgramVoiceAgentAuthOptions {
  if (!auth.credential) throw new Error('Deepgram credential is required');
  if (auth.type === 'token') return { authorization: `Token ${auth.credential}` };
  if (auth.type === 'bearer') return { authorization: `Bearer ${auth.credential}` };
  return { protocols: ['token', auth.credential] };
}

export interface DeepgramVoiceAgentSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export type DeepgramVoiceAgentState =
  | 'awaiting-welcome'
  | 'awaiting-settings-applied'
  | 'ready'
  | 'failed';

export type DeepgramVoiceAgentMessage = { type: string; [key: string]: unknown };
export type DeepgramVoiceAgentInbound = DeepgramVoiceAgentMessage | Uint8Array;

export class DeepgramVoiceAgentClient {
  state: DeepgramVoiceAgentState = 'awaiting-welcome';
  private readonly listeners = new Set<(message: DeepgramVoiceAgentInbound) => void>();

  constructor(
    private readonly socket: DeepgramVoiceAgentSocket,
    private readonly settings: DeepgramVoiceAgentMessage,
  ) {
    if (settings.type !== 'Settings') throw new Error('Initial message must be Settings');
  }

  onMessage(listener: (message: DeepgramVoiceAgentInbound) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(data: string | Uint8Array): void {
    if (data instanceof Uint8Array) {
      this.emit(data);
      return;
    }
    const message = JSON.parse(data) as DeepgramVoiceAgentMessage;
    if (message.type === 'Welcome' && this.state === 'awaiting-welcome') {
      this.socket.send(JSON.stringify(this.settings));
      this.state = 'awaiting-settings-applied';
    } else if (message.type === 'SettingsApplied' && this.state === 'awaiting-settings-applied') {
      this.state = 'ready';
    } else if (message.type === 'Error') {
      this.state = 'failed';
      this.socket.close();
    }
    this.emit(message);
  }

  send(message: DeepgramVoiceAgentMessage): void {
    this.assertReady();
    this.socket.send(JSON.stringify(message));
  }

  sendAudio(audio: Uint8Array): void {
    this.assertReady();
    this.socket.send(audio);
  }

  injectUserMessage(content: string): void {
    this.send({ type: 'InjectUserMessage', content });
  }

  private assertReady(): void {
    if (this.state !== 'ready') {
      throw new Error('Wait for SettingsApplied before sending conversation data');
    }
  }

  private emit(message: DeepgramVoiceAgentInbound): void {
    for (const listener of this.listeners) listener(message);
  }
}
