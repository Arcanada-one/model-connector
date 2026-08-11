import { describe, expect, it } from 'vitest';

interface TransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: FormData;
}

interface TransportResponse {
  status: number;
  body: unknown;
}

interface TestTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

interface TestConnector {
  generateV4(request: Record<string, unknown>): Promise<unknown>;
  generateV4Async(request: Record<string, unknown>, webhookUrl: string): Promise<unknown>;
  getGeneration(generationId: string): Promise<unknown>;
  remixV4(request: Record<string, unknown>): Promise<unknown>;
  generateV3(request: Record<string, unknown>): Promise<unknown>;
  generateTransparentV3(request: Record<string, unknown>): Promise<unknown>;
  inpaintV3(request: Record<string, unknown>): Promise<unknown>;
  remixV3(request: Record<string, unknown>): Promise<unknown>;
  reframeV3(request: Record<string, unknown>): Promise<unknown>;
  replaceBackgroundV3(request: Record<string, unknown>): Promise<unknown>;
  removeBackground(request: Record<string, unknown>): Promise<unknown>;
  layerizeTextV3(request: Record<string, unknown>): Promise<unknown>;
  editWithPrompt(request: Record<string, unknown>): Promise<unknown>;
  upscale(request: Record<string, unknown>): Promise<unknown>;
}

interface IdeogramModule {
  IdeogramConnector: new (apiKey: string, transport: TestTransport) => TestConnector;
}

class RecordingTransport implements TestTransport {
  readonly requests: TransportRequest[] = [];
  private readonly responses: TransportResponse[];

  constructor(...responses: TransportResponse[]) {
    this.responses = responses;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return this.responses.shift() ?? { status: 200, body: {} };
  }
}

const success = (body: unknown = { created: '2026-07-14T00:00:00Z', data: [] }) => ({
  status: 200,
  body,
});

const image = (name: string) => new Blob([name], { type: 'image/png' });

async function loadModule(): Promise<IdeogramModule> {
  const modulePath = './ideogram.connector';
  return import(modulePath) as Promise<IdeogramModule>;
}

async function setup(...responses: TransportResponse[]) {
  const { IdeogramConnector } = await loadModule();
  const transport = new RecordingTransport(...responses);
  const connector = new IdeogramConnector('offline-test-key', transport);
  return { connector, transport };
}

function onlyRequest(transport: RecordingTransport): TransportRequest {
  expect(transport.requests).toHaveLength(1);
  return transport.requests[0];
}

function expectMultipartAuth(request: TransportRequest): FormData {
  expect(request.headers).toEqual({ 'Api-Key': 'offline-test-key' });
  expect(Object.keys(request.headers)).not.toContain('Content-Type');
  expect(request.body).toBeInstanceOf(FormData);
  return request.body as FormData;
}

async function expectBlobPart(part: FormDataEntryValue | null, expected: Blob): Promise<void> {
  expect(part).toBeInstanceOf(Blob);
  const actual = part as Blob;
  expect(actual.type).toBe(expected.type);
  expect(await actual.arrayBuffer()).toEqual(await expected.arrayBuffer());
}

describe('IdeogramConnector provider-native contract', () => {
  it('serializes V4 text and structured generation without inventing a content type', async () => {
    const first = await setup(success({ response_type: 'url', created: 'now', data: [] }));
    await expect(
      first.connector.generateV4({
        text_prompt: 'a precise diagram',
        resolution: '2048x2048',
        rendering_speed: 'QUALITY',
        enable_copyright_detection: null,
      }),
    ).resolves.toEqual({ response_type: 'url', created: 'now', data: [] });

    const request = onlyRequest(first.transport);
    expect(request).toMatchObject({
      method: 'POST',
      url: 'https://api.ideogram.ai/v1/ideogram-v4/generate',
    });
    const form = expectMultipartAuth(request);
    expect(form.get('text_prompt')).toBe('a precise diagram');
    expect(form.get('resolution')).toBe('2048x2048');
    expect(form.get('rendering_speed')).toBe('QUALITY');
    expect(form.get('enable_copyright_detection')).toBe('null');

    const structured = {
      high_level_description: 'poster',
      style_description: { medium: 'screen print' },
      compositional_deconstruction: {
        background: 'navy',
        elements: [{ type: 'text', text: 'ARCANA', desc: 'large title' }],
      },
    };
    const second = await setup(success());
    await second.connector.generateV4({ json_prompt: structured });
    expect(expectMultipartAuth(onlyRequest(second.transport)).get('json_prompt')).toBe(
      JSON.stringify(structured),
    );
  });

  it('implements the V4 async lifecycle with encoded webhook and generation identifiers', async () => {
    const pending = { generation_id: 'job/one', status: 'pending', created: 'now' };
    const { connector, transport } = await setup(
      success({ generation_id: 'job/one' }),
      success(pending),
    );

    await expect(
      connector.generateV4Async(
        { text_prompt: 'async scene' },
        'https://receiver.example/hook?tenant=a&mode=1',
      ),
    ).resolves.toEqual({ generation_id: 'job/one' });
    await expect(connector.getGeneration('job/one')).resolves.toEqual(pending);

    expect(transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.ideogram.ai/v1/ideogram-v4/async/generate?webhook_url=https%3A%2F%2Freceiver.example%2Fhook%3Ftenant%3Da%26mode%3D1',
    });
    expect(expectMultipartAuth(transport.requests[0]).get('text_prompt')).toBe('async scene');
    expect(transport.requests[1]).toMatchObject({
      method: 'GET',
      url: 'https://api.ideogram.ai/v1/generations/job%2Fone',
      headers: { 'Api-Key': 'offline-test-key' },
    });
    expect(transport.requests[1].body).toBeUndefined();
  });

  it('serializes V4 remix assets and operation-specific fields', async () => {
    const source = image('v4-source');
    const { connector, transport } = await setup(success());
    await connector.remixV4({
      image: source,
      text_prompt: 'turn it into ink',
      image_weight: 75,
      rendering_speed: 'DEFAULT',
    });

    const request = onlyRequest(transport);
    expect(request).toMatchObject({
      method: 'POST',
      url: 'https://api.ideogram.ai/v1/ideogram-v4/remix',
    });
    const form = expectMultipartAuth(request);
    await expectBlobPart(form.get('image'), source);
    expect(form.get('text_prompt')).toBe('turn it into ink');
    expect(form.get('image_weight')).toBe('75');
  });

  it('serializes V3 generation palettes and repeated reference assets', async () => {
    const styleOne = image('style-one');
    const styleTwo = image('style-two');
    const character = image('character');
    const mask = image('character-mask');
    const palette = { members: [{ color_hex: '#112233', color_weight: 0.75 }] };
    const { connector, transport } = await setup(success());

    await connector.generateV3({
      prompt: 'v3 poster',
      resolution: '1024x1024',
      rendering_speed: 'TURBO',
      magic_prompt: 'OFF',
      num_images: 2,
      color_palette: palette,
      style_codes: ['A1B2C3D4', '11223344'],
      style_type: 'DESIGN',
      style_preset: 'FLAT_ART',
      style_reference_images: [styleOne, styleTwo],
      character_reference_images: [character],
      character_reference_images_mask: [mask],
    });

    const request = onlyRequest(transport);
    expect(request.url).toBe('https://api.ideogram.ai/v1/ideogram-v3/generate');
    const form = expectMultipartAuth(request);
    expect(form.get('color_palette')).toBe(JSON.stringify(palette));
    expect(form.getAll('style_codes')).toEqual(['A1B2C3D4', '11223344']);
    const styleParts = form.getAll('style_reference_images');
    expect(styleParts).toHaveLength(2);
    await expectBlobPart(styleParts[0], styleOne);
    await expectBlobPart(styleParts[1], styleTwo);
    await expectBlobPart(form.get('character_reference_images'), character);
    await expectBlobPart(form.get('character_reference_images_mask'), mask);
    expect(form.get('num_images')).toBe('2');
  });

  it('covers transparent generation and inpainting with exact V3 routes and parts', async () => {
    const initial = image('initial');
    const mask = image('mask');
    const { connector, transport } = await setup(success(), success());

    await connector.generateTransparentV3({
      prompt: 'transparent icon',
      upscale_factor: 'X4',
      aspect_ratio: '1x1',
      rendering_speed: 'QUALITY',
    });
    await connector.inpaintV3({
      image: initial,
      mask,
      prompt: 'replace selected area',
      style_codes: ['ABCDEF12'],
    });

    expect(transport.requests.map(({ url }) => url)).toEqual([
      'https://api.ideogram.ai/v1/ideogram-v3/generate-transparent',
      'https://api.ideogram.ai/v1/ideogram-v3/inpaint',
    ]);
    const transparent = expectMultipartAuth(transport.requests[0]);
    expect(transparent.get('upscale_factor')).toBe('X4');
    expect(transparent.get('aspect_ratio')).toBe('1x1');
    const inpaint = expectMultipartAuth(transport.requests[1]);
    await expectBlobPart(inpaint.get('image'), initial);
    await expectBlobPart(inpaint.get('mask'), mask);
    expect(inpaint.get('prompt')).toBe('replace selected area');
  });

  it('covers V3 remix, reframe, and replace-background without route normalization', async () => {
    const initial = image('source');
    const { connector, transport } = await setup(success(), success(), success());

    await connector.remixV3({ image: initial, prompt: 'remix', image_weight: 40 });
    await connector.reframeV3({
      image: initial,
      resolution: '1344x768',
      num_images: 3,
      color_palette: { name: 'EMBER' },
    });
    await connector.replaceBackgroundV3({
      image: initial,
      prompt: 'quiet forest',
      magic_prompt: 'AUTO',
    });

    expect(transport.requests.map(({ url }) => url)).toEqual([
      'https://api.ideogram.ai/v1/ideogram-v3/remix',
      'https://api.ideogram.ai/v1/ideogram-v3/reframe',
      'https://api.ideogram.ai/v1/ideogram-v3/replace-background',
    ]);
    expect(expectMultipartAuth(transport.requests[0]).get('image_weight')).toBe('40');
    expect(expectMultipartAuth(transport.requests[1]).get('color_palette')).toBe(
      JSON.stringify({ name: 'EMBER' }),
    );
    expect(expectMultipartAuth(transport.requests[2]).get('prompt')).toBe('quiet forest');
  });

  it('covers remove-background, Layerize, and prompt edit while preserving provider fields', async () => {
    const initial = image('source');
    const layerized = {
      base_image_url: 'https://images.example/base.png',
      original_image_url: null,
      seed: 12,
      text_blocks: [{ provider_shape: 'unclaimed' }],
    };
    const { connector, transport } = await setup(success(), success(layerized), success());

    await connector.removeBackground({ image: initial });
    await expect(
      connector.layerizeTextV3({ image: initial, prompt: 'extract title', seed: 12 }),
    ).resolves.toEqual(layerized);
    await connector.editWithPrompt({
      prompt: 'combine references',
      images: [initial, image('second')],
      image_urls: ['https://ideogram.ai/assets/one', 'https://ideogram.ai/assets/two'],
      num_images: 2,
      transparent_background: false,
    });

    expect(transport.requests.map(({ url }) => url)).toEqual([
      'https://api.ideogram.ai/v1/remove-background',
      'https://api.ideogram.ai/v1/ideogram-v3/layerize-text',
      'https://api.ideogram.ai/v1/edit',
    ]);
    const edit = expectMultipartAuth(transport.requests[2]);
    expect(edit.getAll('images')).toHaveLength(2);
    expect(edit.getAll('image_urls')).toEqual([
      'https://ideogram.ai/assets/one',
      'https://ideogram.ai/assets/two',
    ]);
    expect(edit.get('transparent_background')).toBe('false');
  });

  it('uses the documented unversioned upscale route and JSON image_request part', async () => {
    const source = image('upscale');
    const imageRequest = {
      prompt: 'retain line work',
      resemblance: 55,
      detail: 90,
      magic_prompt_option: 'OFF',
      num_images: 1,
      seed: 7,
    };
    const { connector, transport } = await setup(success());

    await connector.upscale({ image_request: imageRequest, image_file: source });

    const request = onlyRequest(transport);
    expect(request.url).toBe('https://api.ideogram.ai/upscale');
    const form = expectMultipartAuth(request);
    expect(form.get('image_request')).toBe(JSON.stringify(imageRequest));
    await expectBlobPart(form.get('image_file'), source);
  });

  it.each([
    [400, { message: 'invalid' }],
    [401, 'unauthorized'],
    [402, { payment: 'required' }],
    [403, null],
    [422, { error: 'safety check failed' }],
    [429, { arbitrary: ['rate limited'] }],
    [503, '<html>unavailable</html>'],
  ])('preserves provider error status and raw body for HTTP %i', async (status, body) => {
    const { connector } = await setup({ status, body });

    const caught = await connector
      .generateV4({ text_prompt: 'error path' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({
      name: 'IdeogramApiError',
      status,
      path: '/v1/ideogram-v4/generate',
      body,
    });
    expect(JSON.stringify(caught)).not.toContain('offline-test-key');
  });
});
