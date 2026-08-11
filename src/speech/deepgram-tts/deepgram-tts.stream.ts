import { buildDeepgramSpeakUrl, deepgramWebSocketProtocols } from './deepgram-tts.url';
import type {
  DeepgramTtsEvent,
  DeepgramTtsRequest,
  DeepgramWebSocket,
  DeepgramWebSocketFactory,
} from './deepgram-tts.types';

export class DeepgramTtsStreamError extends Error {
  constructor(
    readonly closeCode: number,
    readonly closeReason: string,
  ) {
    super(`Deepgram Aura WebSocket closed abnormally (${closeCode}): ${closeReason}`);
    this.name = 'DeepgramTtsStreamError';
  }
}

class DeepgramAuraSession {
  private readonly eventHandlers: Array<(event: DeepgramTtsEvent) => void> = [];
  private readonly errorHandlers: Array<(error: Error) => void> = [];

  constructor(private readonly socket: DeepgramWebSocket) {
    socket.addEventListener('message', (event) => this.handleMessage(event));
    socket.addEventListener('close', (event) => this.handleClose(event));
    socket.addEventListener('error', () =>
      this.emitError(new Error('Deepgram Aura WebSocket transport error')),
    );
  }

  onEvent(handler: (event: DeepgramTtsEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  speak(text: string): void {
    if (!text.length) throw new TypeError('Speak text must not be empty');
    this.send({ type: 'Speak', text });
  }

  flush(): void {
    this.send({ type: 'Flush' });
  }

  clear(): void {
    this.send({ type: 'Clear' });
  }

  finish(): void {
    this.send({ type: 'Close' });
  }

  closeTransport(code = 1000, reason = 'client closed'): void {
    this.socket.close(code, reason);
  }

  private send(message: Record<string, string>): void {
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(rawEvent: unknown): void {
    const data = (rawEvent as { data?: unknown }).data;
    if (data instanceof ArrayBuffer) {
      this.emitEvent({ type: 'Audio', audio: new Uint8Array(data) });
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.emitEvent({
        type: 'Audio',
        audio: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      });
      return;
    }
    if (typeof data !== 'string') return;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (['Metadata', 'Flushed', 'Cleared', 'Warning'].includes(String(parsed.type))) {
        this.emitEvent(parsed as DeepgramTtsEvent);
      }
    } catch {
      this.emitError(new Error('Deepgram Aura returned an invalid JSON event'));
    }
  }

  private handleClose(rawEvent: unknown): void {
    const event = rawEvent as { code?: number; reason?: string };
    const code = event.code ?? 1006;
    if (code !== 1000) this.emitError(new DeepgramTtsStreamError(code, event.reason ?? ''));
  }

  private emitEvent(event: DeepgramTtsEvent): void {
    this.eventHandlers.forEach((handler) => handler(event));
  }

  private emitError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error));
  }
}

export class DeepgramAuraStream {
  constructor(private readonly dependencies: { factory: DeepgramWebSocketFactory }) {}

  connect(request: Omit<DeepgramTtsRequest, 'text'>): DeepgramAuraSession {
    const socket = this.dependencies.factory(
      buildDeepgramSpeakUrl(request, 'websocket'),
      deepgramWebSocketProtocols(request.auth),
    );
    return new DeepgramAuraSession(socket);
  }
}
