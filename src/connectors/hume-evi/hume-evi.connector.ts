import type {
  HumeAuth,
  HumeChatOptions,
  HumeFrame,
  HumeFrameHandlers,
  HumeHttpRequest,
  HumeHttpResponse,
  HumeHttpTransport,
  HumePagination,
  HumeSocket,
} from './hume-evi.types';

const REST_BASE_URL = 'https://api.hume.ai';
const CHAT_URL = 'wss://api.hume.ai/v0/evi/chat';

export const HUME_EVI_CAPABILITIES = Object.freeze({
  provider: 'hume-evi',
  restBaseUrl: REST_BASE_URL,
  websocketUrl: CHAT_URL,
  realtimeSpeechToSpeech: true,
  supportingRest: ['configs', 'chats', 'chat_groups', 'chat_group_events'],
});

export class HumeEviConnector {
  constructor(private readonly dependencies: { httpTransport: HumeHttpTransport }) {}

  createConfig(auth: HumeAuth, body: Record<string, unknown>) {
    return this.request(auth, 'POST', '/v0/evi/configs', undefined, body);
  }

  listConfigs(auth: HumeAuth, pagination?: HumePagination) {
    return this.request(auth, 'GET', '/v0/evi/configs', this.pagination(pagination));
  }

  getConfig(auth: HumeAuth, configId: string, version?: number) {
    return this.request(auth, 'GET', `/v0/evi/configs/${encodeURIComponent(configId)}`, {
      version,
    });
  }

  updateConfig(auth: HumeAuth, configId: string, body: Record<string, unknown>) {
    return this.request(
      auth,
      'POST',
      `/v0/evi/configs/${encodeURIComponent(configId)}`,
      undefined,
      body,
    );
  }

  deleteConfig(auth: HumeAuth, configId: string) {
    return this.request(auth, 'DELETE', `/v0/evi/configs/${encodeURIComponent(configId)}`);
  }

  listChats(auth: HumeAuth, pagination?: HumePagination) {
    return this.request(auth, 'GET', '/v0/evi/chats', this.pagination(pagination));
  }

  listChatGroups(auth: HumeAuth, pagination?: HumePagination) {
    return this.request(auth, 'GET', '/v0/evi/chat_groups', this.pagination(pagination));
  }

  listChatGroupEvents(auth: HumeAuth, chatGroupId: string, pagination?: HumePagination) {
    return this.request(
      auth,
      'GET',
      `/v0/evi/chat_groups/${encodeURIComponent(chatGroupId)}/events`,
      this.pagination(pagination),
    );
  }

  buildChatUrl(auth: HumeAuth, options: HumeChatOptions = {}): string {
    this.assertAuth(auth);
    const url = new URL(CHAT_URL);
    if (auth.apiKey !== undefined) url.searchParams.set('api_key', auth.apiKey);
    if (auth.accessToken !== undefined) url.searchParams.set('access_token', auth.accessToken);
    this.set(url, 'config_id', options.configId);
    this.set(url, 'config_version', options.configVersion);
    this.set(url, 'resumed_chat_group_id', options.resumedChatGroupId);
    this.set(url, 'verbose_transcription', options.verboseTranscription);
    this.set(url, 'allow_connection', options.allowConnection);
    return url.toString();
  }

  sendAudio(socket: HumeSocket, data: string): void {
    socket.send(JSON.stringify({ type: 'audio_input', data }));
  }

  handleFrame(frame: HumeFrame, handlers: HumeFrameHandlers): void {
    handlers.onFrame(frame);
    if (
      frame.type === 'user_interruption' ||
      (handlers.verboseTranscription === true &&
        frame.type === 'user_message' &&
        frame.interim === true)
    ) {
      handlers.onStopPlayback?.(frame);
    }
  }

  private async request(
    auth: HumeAuth,
    method: HumeHttpRequest['method'],
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<HumeHttpResponse> {
    this.assertAuth(auth);
    const url = new URL(path, REST_BASE_URL);
    for (const [name, value] of Object.entries(query ?? {})) this.set(url, name, value);
    const headers: Record<string, string> = {};
    if (auth.apiKey !== undefined) headers['X-Hume-Api-Key'] = auth.apiKey;
    if (auth.accessToken !== undefined) headers.Authorization = `Bearer ${auth.accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return this.dependencies.httpTransport({
      method,
      url: url.toString(),
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  private pagination(value?: HumePagination) {
    return {
      page_number: value?.pageNumber,
      page_size: value?.pageSize,
      ascending_order: value?.ascendingOrder,
    };
  }

  private assertAuth(auth: HumeAuth): void {
    const count =
      Number(typeof auth.apiKey === 'string' && auth.apiKey.length > 0) +
      Number(typeof auth.accessToken === 'string' && auth.accessToken.length > 0);
    if (count !== 1) throw new Error('Hume EVI requires exactly one authentication mode');
  }

  private set(url: URL, name: string, value: string | number | boolean | undefined): void {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
}
