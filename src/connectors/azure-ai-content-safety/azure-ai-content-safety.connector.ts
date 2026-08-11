import sharp from 'sharp';

export const AZURE_CONTENT_SAFETY_API_VERSION = '2024-09-01' as const;

export const AZURE_CONTENT_SAFETY_CATEGORIES = [
  'Hate',
  'SelfHarm',
  'Sexual',
  'Violence',
] as const;

export type AzureContentSafetyCategory = (typeof AZURE_CONTENT_SAFETY_CATEGORIES)[number];
export type TextOutputType = 'FourSeverityLevels' | 'EightSeverityLevels';
export type ImageOutputType = 'FourSeverityLevels';

export interface AzureContentSafetyTransportRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  redirect: 'manual';
  timeoutMs: number;
}

export interface AzureContentSafetyTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type AzureContentSafetyTransport = (
  url: string,
  request: AzureContentSafetyTransportRequest,
) => Promise<AzureContentSafetyTransportResponse>;

export interface ImageMetadata {
  format?: string;
  width?: number;
  height?: number;
}

export type ImageInspector = (image: Buffer) => Promise<ImageMetadata>;

export type AzureContentSafetyAuth =
  | { type: 'apiKey'; value: string }
  | { type: 'bearerToken'; value: string };

export interface AzureContentSafetyConfig {
  endpoint: string;
  auth: AzureContentSafetyAuth;
  transport?: AzureContentSafetyTransport;
  inspectImage?: ImageInspector;
  timeoutMs?: number;
}

export interface TextAnalysisRequest {
  text: string;
  categories?: AzureContentSafetyCategory[];
  blocklistNames?: string[];
  haltOnBlocklistHit?: boolean;
  outputType?: TextOutputType;
}

export interface ImageAnalysisRequest {
  content: string;
  categories?: AzureContentSafetyCategory[];
  outputType?: ImageOutputType;
}

export interface CategoryAnalysis {
  category: AzureContentSafetyCategory;
  severity: number;
}

export interface BlocklistMatch {
  blocklistName: string;
  blocklistItemId: string;
}

export interface ContentSafetyAnalysisResult {
  outputType: TextOutputType;
  categories: CategoryAnalysis[];
  blocklistMatches: BlocklistMatch[];
}

type ErrorCode =
  | 'invalid_config'
  | 'invalid_request'
  | 'invalid_image'
  | 'http_error'
  | 'transport_error'
  | 'response_too_large'
  | 'invalid_response';

interface ErrorOptions {
  status?: number;
  providerCode?: string;
  retryable?: boolean;
}

export class AzureContentSafetyError extends Error {
  readonly name = 'AzureContentSafetyError';
  readonly code: ErrorCode;
  readonly status?: number;
  readonly providerCode?: string;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(message);
    this.code = code;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.retryable = options.retryable ?? false;
  }
}

const TEXT_PATH = `/contentsafety/text:analyze?api-version=${AZURE_CONTENT_SAFETY_API_VERSION}`;
const IMAGE_PATH = `/contentsafety/image:analyze?api-version=${AZURE_CONTENT_SAFETY_API_VERSION}`;
const RESOURCE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cognitiveservices\.azure\.com$/i;
const MAX_TEXT_CODE_POINTS = 10_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 50;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SECRET_LENGTH = 8192;
const DEFAULT_TIMEOUT_MS = 30_000;
const SUPPORTED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainRecord(value: unknown, code: ErrorCode, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new AzureContentSafetyError(code, `${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: ErrorCode,
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new AzureContentSafetyError(code, `${label} contains an unsupported field`);
    }
  }
}

function normalizeEndpoint(input: unknown): string {
  if (typeof input !== 'string' || input.length > 512) {
    throw new AzureContentSafetyError('invalid_config', 'Azure endpoint is invalid');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AzureContentSafetyError('invalid_config', 'Azure endpoint is invalid');
  }
  const rawMatchesOrigin = input === url.origin || input === `${url.origin}/`;
  if (
    !rawMatchesOrigin ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !RESOURCE_HOST.test(url.hostname)
  ) {
    throw new AzureContentSafetyError('invalid_config', 'Azure endpoint is not an allowed origin');
  }
  return url.origin;
}

function normalizeAuth(input: unknown): AzureContentSafetyAuth {
  const auth = assertPlainRecord(input, 'invalid_config', 'Authentication');
  assertExactKeys(auth, ['type', 'value'], 'invalid_config', 'Authentication');
  if (auth.type !== 'apiKey' && auth.type !== 'bearerToken') {
    throw new AzureContentSafetyError('invalid_config', 'Authentication type is invalid');
  }
  if (
    typeof auth.value !== 'string' ||
    auth.value.trim().length === 0 ||
    auth.value.length > MAX_SECRET_LENGTH ||
    /[\r\n]/.test(auth.value)
  ) {
    throw new AzureContentSafetyError('invalid_config', 'Authentication value is invalid');
  }
  return { type: auth.type, value: auth.value };
}

function normalizeCategories(input: unknown): AzureContentSafetyCategory[] {
  if (input === undefined) return [...AZURE_CONTENT_SAFETY_CATEGORIES];
  if (!Array.isArray(input) || input.length === 0 || input.length > 4) {
    throw new AzureContentSafetyError('invalid_request', 'Categories are invalid');
  }
  const categories: AzureContentSafetyCategory[] = [];
  for (const value of input) {
    if (
      typeof value !== 'string' ||
      !AZURE_CONTENT_SAFETY_CATEGORIES.includes(value as AzureContentSafetyCategory) ||
      categories.includes(value as AzureContentSafetyCategory)
    ) {
      throw new AzureContentSafetyError('invalid_request', 'Categories are invalid');
    }
    categories.push(value as AzureContentSafetyCategory);
  }
  return categories;
}

function normalizeBlocklistNames(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new AzureContentSafetyError('invalid_request', 'Blocklist names are invalid');
  }
  const names: string[] = [];
  for (const value of input) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 64 ||
      names.includes(value)
    ) {
      throw new AzureContentSafetyError('invalid_request', 'Blocklist names are invalid');
    }
    names.push(value);
  }
  return names;
}

function hasOnlyBase64Characters(input: string): boolean {
  const paddingStart = input.endsWith('==') ? input.length - 2 : input.endsWith('=') ? input.length - 1 : input.length;
  for (let index = 0; index < paddingStart; index += 1) {
    const code = input.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return false;
  }
  for (let index = paddingStart; index < input.length; index += 1) {
    if (input.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function decodeBase64(input: unknown): Buffer {
  if (typeof input !== 'string' || input.length === 0) {
    throw new AzureContentSafetyError('invalid_request', 'Image content must be base64');
  }
  const maxEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
  if (
    input.length > maxEncodedLength ||
    input.length % 4 !== 0 ||
    !hasOnlyBase64Characters(input)
  ) {
    throw new AzureContentSafetyError('invalid_request', 'Image content must be canonical base64');
  }
  const decoded = Buffer.from(input, 'base64');
  if (decoded.toString('base64') !== input) {
    throw new AzureContentSafetyError('invalid_request', 'Image content must be canonical base64');
  }
  if (decoded.byteLength > MAX_IMAGE_BYTES) {
    throw new AzureContentSafetyError('invalid_image', 'Image exceeds the decoded size limit');
  }
  return decoded;
}

async function defaultImageInspector(image: Buffer): Promise<ImageMetadata> {
  const metadata = await sharp(image, {
    animated: false,
    limitInputPixels: MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION,
  }).metadata();
  return { format: metadata.format, width: metadata.width, height: metadata.height };
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new AzureContentSafetyError('response_too_large', 'Provider response exceeds limit');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AzureContentSafetyError('response_too_large', 'Provider response exceeds limit');
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

const defaultTransport: AzureContentSafetyTransport = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'x-ms-error-code') headers['x-ms-error-code'] = value;
  });
  return { status: response.status, headers, body: await readBoundedResponse(response) };
};

function safeProviderCode(response: AzureContentSafetyTransportResponse): string | undefined {
  const header = Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === 'x-ms-error-code',
  )?.[1];
  if (typeof header === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(header)) return header;
  if (Buffer.byteLength(response.body, 'utf8') > MAX_RESPONSE_BYTES) return undefined;
  try {
    const parsed = JSON.parse(response.body) as unknown;
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.error)) return undefined;
    const code = parsed.error.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

export class AzureAiContentSafetyConnector {
  private readonly endpoint: string;
  private readonly auth: AzureContentSafetyAuth;
  private readonly transport: AzureContentSafetyTransport;
  private readonly inspectImage: ImageInspector;
  private readonly timeoutMs: number;

  constructor(configInput: AzureContentSafetyConfig) {
    const config = assertPlainRecord(configInput, 'invalid_config', 'Configuration');
    assertExactKeys(
      config,
      ['endpoint', 'auth', 'transport', 'inspectImage', 'timeoutMs'],
      'invalid_config',
      'Configuration',
    );
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.auth = normalizeAuth(config.auth);
    if (config.transport !== undefined && typeof config.transport !== 'function') {
      throw new AzureContentSafetyError('invalid_config', 'Transport must be a function');
    }
    if (config.inspectImage !== undefined && typeof config.inspectImage !== 'function') {
      throw new AzureContentSafetyError('invalid_config', 'Image inspector must be a function');
    }
    const timeoutMs = config.timeoutMs;
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000)
    ) {
      throw new AzureContentSafetyError('invalid_config', 'Timeout is invalid');
    }
    this.transport = (config.transport as AzureContentSafetyTransport | undefined) ?? defaultTransport;
    this.inspectImage = (config.inspectImage as ImageInspector | undefined) ?? defaultImageInspector;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async analyzeText(input: unknown): Promise<ContentSafetyAnalysisResult> {
    const request = assertPlainRecord(input, 'invalid_request', 'Text request');
    assertExactKeys(
      request,
      ['text', 'categories', 'blocklistNames', 'haltOnBlocklistHit', 'outputType'],
      'invalid_request',
      'Text request',
    );
    if (
      typeof request.text !== 'string' ||
      request.text.length === 0 ||
      [...request.text].length > MAX_TEXT_CODE_POINTS
    ) {
      throw new AzureContentSafetyError('invalid_request', 'Text is invalid');
    }
    const categories = normalizeCategories(request.categories);
    const blocklistNames = normalizeBlocklistNames(request.blocklistNames);
    if (request.haltOnBlocklistHit !== undefined && typeof request.haltOnBlocklistHit !== 'boolean') {
      throw new AzureContentSafetyError('invalid_request', 'haltOnBlocklistHit is invalid');
    }
    const outputType = request.outputType ?? 'FourSeverityLevels';
    if (outputType !== 'FourSeverityLevels' && outputType !== 'EightSeverityLevels') {
      throw new AzureContentSafetyError('invalid_request', 'Text output type is invalid');
    }
    const body: Record<string, unknown> = { text: request.text, categories, outputType };
    if (blocklistNames !== undefined) body.blocklistNames = blocklistNames;
    if (request.haltOnBlocklistHit !== undefined) {
      body.haltOnBlocklistHit = request.haltOnBlocklistHit;
    }
    return this.execute(TEXT_PATH, body, categories, outputType, true);
  }

  async analyzeImage(input: unknown): Promise<ContentSafetyAnalysisResult> {
    const request = assertPlainRecord(input, 'invalid_request', 'Image request');
    assertExactKeys(request, ['content', 'categories', 'outputType'], 'invalid_request', 'Image request');
    if (request.outputType !== undefined && request.outputType !== 'FourSeverityLevels') {
      throw new AzureContentSafetyError('invalid_request', 'Image output type is invalid');
    }
    const categories = normalizeCategories(request.categories);
    const image = decodeBase64(request.content);
    let metadata: ImageMetadata;
    try {
      metadata = await this.inspectImage(image);
    } catch {
      throw new AzureContentSafetyError('invalid_image', 'Image metadata is invalid');
    }
    if (
      !isPlainRecord(metadata) ||
      typeof metadata.format !== 'string' ||
      !SUPPORTED_IMAGE_FORMATS.has(metadata.format) ||
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height) ||
      (metadata.width as number) < MIN_IMAGE_DIMENSION ||
      (metadata.width as number) > MAX_IMAGE_DIMENSION ||
      (metadata.height as number) < MIN_IMAGE_DIMENSION ||
      (metadata.height as number) > MAX_IMAGE_DIMENSION
    ) {
      throw new AzureContentSafetyError('invalid_image', 'Image metadata is outside allowed limits');
    }
    const outputType: ImageOutputType = 'FourSeverityLevels';
    return this.execute(
      IMAGE_PATH,
      { image: { content: request.content }, categories, outputType },
      categories,
      outputType,
      false,
    );
  }

  private async execute(
    path: string,
    body: Record<string, unknown>,
    categories: AzureContentSafetyCategory[],
    outputType: TextOutputType,
    allowBlocklists: boolean,
  ): Promise<ContentSafetyAnalysisResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.auth.type === 'apiKey') {
      headers['Ocp-Apim-Subscription-Key'] = this.auth.value;
    } else {
      headers.Authorization = `Bearer ${this.auth.value}`;
    }
    let response: AzureContentSafetyTransportResponse;
    try {
      response = await this.transport(`${this.endpoint}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof AzureContentSafetyError) throw error;
      throw new AzureContentSafetyError('transport_error', 'Azure Content Safety transport failed', {
        retryable: true,
      });
    }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new AzureContentSafetyError('invalid_response', 'Provider status is invalid');
    }
    if (typeof response.body !== 'string') {
      throw new AzureContentSafetyError('invalid_response', 'Provider response is invalid');
    }
    if (Buffer.byteLength(response.body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new AzureContentSafetyError('response_too_large', 'Provider response exceeds limit');
    }
    if (response.status !== 200) {
      throw new AzureContentSafetyError('http_error', 'Azure Content Safety request failed', {
        status: response.status,
        providerCode: safeProviderCode(response),
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return this.parseSuccess(response.body, categories, outputType, allowBlocklists);
  }

  private parseSuccess(
    body: string,
    requestedCategories: AzureContentSafetyCategory[],
    outputType: TextOutputType,
    allowBlocklists: boolean,
  ): ContentSafetyAnalysisResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new AzureContentSafetyError('invalid_response', 'Provider response is not valid JSON');
    }
    const response = assertPlainRecord(parsed, 'invalid_response', 'Provider response');
    assertExactKeys(
      response,
      allowBlocklists ? ['categoriesAnalysis', 'blocklistsMatch'] : ['categoriesAnalysis'],
      'invalid_response',
      'Provider response',
    );
    if (!Array.isArray(response.categoriesAnalysis) || response.categoriesAnalysis.length > 4) {
      throw new AzureContentSafetyError('invalid_response', 'Category analysis is invalid');
    }
    const found = new Map<AzureContentSafetyCategory, number>();
    for (const itemInput of response.categoriesAnalysis) {
      const item = assertPlainRecord(itemInput, 'invalid_response', 'Category analysis');
      assertExactKeys(item, ['category', 'severity'], 'invalid_response', 'Category analysis');
      if (
        typeof item.category !== 'string' ||
        !AZURE_CONTENT_SAFETY_CATEGORIES.includes(item.category as AzureContentSafetyCategory) ||
        !requestedCategories.includes(item.category as AzureContentSafetyCategory) ||
        found.has(item.category as AzureContentSafetyCategory) ||
        !this.isValidSeverity(item.severity, outputType)
      ) {
        throw new AzureContentSafetyError('invalid_response', 'Category analysis is invalid');
      }
      found.set(item.category as AzureContentSafetyCategory, item.severity as number);
    }
    if (found.size !== requestedCategories.length) {
      throw new AzureContentSafetyError('invalid_response', 'Category analysis is incomplete');
    }
    const categories = AZURE_CONTENT_SAFETY_CATEGORIES.filter((category) => found.has(category)).map(
      (category) => ({ category, severity: found.get(category) as number }),
    );
    const blocklistMatches = allowBlocklists
      ? this.parseBlocklistMatches(response.blocklistsMatch)
      : [];
    return { outputType, categories, blocklistMatches };
  }

  private isValidSeverity(value: unknown, outputType: TextOutputType): value is number {
    if (!Number.isInteger(value)) return false;
    if (outputType === 'EightSeverityLevels') return (value as number) >= 0 && (value as number) <= 7;
    return value === 0 || value === 2 || value === 4 || value === 6;
  }

  private parseBlocklistMatches(input: unknown): BlocklistMatch[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input) || input.length > 100) {
      throw new AzureContentSafetyError('invalid_response', 'Blocklist matches are invalid');
    }
    return input.map((itemInput) => {
      const item = assertPlainRecord(itemInput, 'invalid_response', 'Blocklist match');
      assertExactKeys(
        item,
        ['blocklistName', 'blocklistItemId', 'blocklistItemText'],
        'invalid_response',
        'Blocklist match',
      );
      if (
        typeof item.blocklistName !== 'string' ||
        item.blocklistName.length === 0 ||
        item.blocklistName.length > 64 ||
        typeof item.blocklistItemId !== 'string' ||
        item.blocklistItemId.length === 0 ||
        item.blocklistItemId.length > 64 ||
        (item.blocklistItemText !== undefined &&
          (typeof item.blocklistItemText !== 'string' || item.blocklistItemText.length > 128))
      ) {
        throw new AzureContentSafetyError('invalid_response', 'Blocklist match is invalid');
      }
      return { blocklistName: item.blocklistName, blocklistItemId: item.blocklistItemId };
    });
  }
}
