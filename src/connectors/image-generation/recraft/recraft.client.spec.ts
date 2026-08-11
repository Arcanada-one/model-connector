import { describe, expect, it } from 'vitest';
import type { RecraftClient } from './recraft.client';
import { RecraftError } from './recraft.error';
import type { RecraftImageSubStyle } from './recraft.types';

interface RecraftBinaryAsset {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

type RuntimeClient = {
  generateRaster(request: Record<string, unknown>): Promise<unknown>;
  generateVector(request: Record<string, unknown>): Promise<unknown>;
  generate(request: Record<string, unknown>): Promise<unknown>;
  imageToImage(request: Record<string, unknown>): Promise<unknown>;
  inpaint(request: Record<string, unknown>): Promise<unknown>;
  outpaint(request: Record<string, unknown>): Promise<unknown>;
  replaceBackground(request: Record<string, unknown>): Promise<unknown>;
  generateBackground(request: Record<string, unknown>): Promise<unknown>;
  removeBackground(request: Record<string, unknown>): Promise<unknown>;
  vectorize(request: Record<string, unknown>): Promise<unknown>;
  createStyle(request: Record<string, unknown>): Promise<unknown>;
  eraseRegion(request: Record<string, unknown>): Promise<unknown>;
  variateImage(request: Record<string, unknown>): Promise<unknown>;
  explore(request: Record<string, unknown>): Promise<unknown>;
  exploreSimilar(request: Record<string, unknown>): Promise<unknown>;
  crispUpscale(request: Record<string, unknown>): Promise<unknown>;
  creativeUpscale(request: Record<string, unknown>): Promise<unknown>;
  listStyles(): Promise<unknown>;
  listBasicStyles(): Promise<unknown>;
  getStyle(styleId: string): Promise<unknown>;
  deleteStyle(styleId: string): Promise<unknown>;
};

type BodyRuntimeMethod = Exclude<
  keyof RuntimeClient,
  'listStyles' | 'listBasicStyles' | 'getStyle' | 'deleteStyle'
>;

interface RecraftModule {
  RecraftClient: new (apiToken: string, transport: typeof fetch, baseUrl?: string) => RuntimeClient;
}

interface RecordedRequest {
  input: string | URL | Request;
  init?: RequestInit;
}

class RecordingTransport {
  readonly requests: RecordedRequest[] = [];
  readonly fetch: typeof fetch;
  private readonly responses: Response[];

  constructor(...responses: Response[]) {
    this.responses = responses;
    this.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      this.requests.push({ input, init });
      return this.responses.shift() ?? jsonResponse(generationSuccess());
    }) as typeof fetch;
  }
}

const generationSuccess = () => ({
  created: 1_720_000_000,
  credits: 2,
  data: [{ image_id: '00000000-0000-0000-0000-000000000001' }],
});

const processSuccess = () => ({
  created: 1_720_000_001,
  credits: 1,
  image: {
    image_id: '00000000-0000-0000-0000-000000000002',
    b64_json: 'aW1hZ2U=',
  },
});

const styleSuccess = () => ({
  id: '00000000-0000-0000-0000-000000000003',
  style: 'digital_illustration',
  creation_time: '2026-07-14T00:00:00Z',
  is_private: true,
  credits: 4,
});

const styleDetailSuccess = () => ({
  id: '00000000-0000-0000-0000-000000000003',
  style: 'digital_illustration',
  substyle: 'hand_drawn',
  creation_time: '2026-07-14T00:00:00Z',
  is_private: true,
});

const basicStyleSuccess = () => ({
  style_id: '00000000-0000-0000-0000-000000000004',
  style: 'Vector art',
  model: 'recraftv4_vector',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function asset(value: string, filename = `${value}.png`): RecraftBinaryAsset {
  return {
    bytes: new TextEncoder().encode(value),
    filename,
    contentType: 'image/png',
  };
}

async function loadModule(): Promise<RecraftModule> {
  const modulePath = './recraft.client';
  return import(modulePath) as Promise<RecraftModule>;
}

async function setup(...responses: Response[]) {
  const { RecraftClient: RuntimeRecraftClient } = await loadModule();
  const transport = new RecordingTransport(...responses);
  const client = new RuntimeRecraftClient('offline-recraft-token', transport.fetch);
  return { client, transport };
}

function onlyRequest(transport: RecordingTransport): RecordedRequest {
  expect(transport.requests).toHaveLength(1);
  return transport.requests[0];
}

function headersOf(request: RecordedRequest): Headers {
  return new Headers(request.init?.headers);
}

function expectJsonRequest(
  request: RecordedRequest,
  path: string,
  body: Record<string, unknown>,
): void {
  expect(String(request.input)).toBe(`https://external.api.recraft.ai${path}`);
  expect(request.init?.method).toBe('POST');
  expect(headersOf(request).get('Authorization')).toBe('Bearer offline-recraft-token');
  expect(headersOf(request).get('Content-Type')).toBe('application/json');
  expect(request.init?.body).toBe(JSON.stringify(body));
  expect(JSON.parse(request.init?.body as string)).toEqual(body);
}

function expectMultipartRequest(request: RecordedRequest, path: string): FormData {
  expect(String(request.input)).toBe(`https://external.api.recraft.ai${path}`);
  expect(request.init?.method).toBe('POST');
  expect(headersOf(request).get('Authorization')).toBe('Bearer offline-recraft-token');
  expect(headersOf(request).has('Content-Type')).toBe(false);
  expect(request.init?.body).toBeInstanceOf(FormData);
  return request.init?.body as FormData;
}

function expectNoBodyRequest(request: RecordedRequest, method: 'GET' | 'DELETE', path: string) {
  expect(String(request.input)).toBe(`https://external.api.recraft.ai${path}`);
  expect(request.init?.method).toBe(method);
  expect(headersOf(request).get('Authorization')).toBe('Bearer offline-recraft-token');
  expect(headersOf(request).has('Content-Type')).toBe(false);
  expect(request.init?.body).toBeUndefined();
}

async function expectAsset(part: FormDataEntryValue | null, expected: RecraftBinaryAsset) {
  expect(part).toBeInstanceOf(Blob);
  const blob = part as File;
  expect(blob.name).toBe(expected.filename);
  expect(blob.type).toBe(expected.contentType);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(expected.bytes);
}

describe('RecraftClient official AU-017 contract', () => {
  it('serializes generic generation and exploration as exact JSON with optional billing', async () => {
    const generated = await setup(jsonResponse(generationSuccess()));
    await generated.client.generate({
      prompt: 'complete provider boundary',
      model: 'recraftv4_1_pro_vector',
      size: '1:1',
      billing: 'subscription',
    });
    expectJsonRequest(
      onlyRequest(generated.transport),
      '/v1/images/generations?billing=subscription',
      {
        prompt: 'complete provider boundary',
        model: 'recraftv4_1_pro_vector',
        size: '1:1',
      },
    );

    const explored = await setup(jsonResponse(generationSuccess()));
    await explored.client.explore({
      prompt: 'race car',
      model: 'recraftv4_pro_vector',
      controls: { no_text: true },
    });
    expectJsonRequest(onlyRequest(explored.transport), '/v1/images/explore', {
      prompt: 'race car',
      model: 'recraftv4_pro_vector',
      controls: { no_text: true },
    });

    const similar = await setup(jsonResponse(generationSuccess()));
    await similar.client.exploreSimilar({
      source_image_id: '00000000-0000-0000-0000-000000000005',
      similarity: 5,
      response_format: 'b64_json',
    });
    expectJsonRequest(onlyRequest(similar.transport), '/v1/images/explore/similar', {
      source_image_id: '00000000-0000-0000-0000-000000000005',
      similarity: 5,
      response_format: 'b64_json',
    });
  });

  it('forwards optional billing on an existing POST without putting it in the JSON body', async () => {
    const context = await setup(jsonResponse(generationSuccess()));
    await context.client.generateRaster({ prompt: 'billed', billing: 'api' });
    expectJsonRequest(
      onlyRequest(context.transport),
      '/v1/images/generations/raster?billing=api',
      { prompt: 'billed' },
    );
  });

  it('serializes erase, variation, and current upscale JSON requests exactly', async () => {
    const cases: Array<{
      method: 'eraseRegion' | 'variateImage' | 'crispUpscale' | 'creativeUpscale';
      path: string;
      body: Record<string, unknown>;
      response: unknown;
    }> = [
      {
        method: 'eraseRegion',
        path: '/v1/images/eraseRegion',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          mask_url: 'https://assets.example/mask.png',
          response_format: 'url',
        },
        response: processSuccess(),
      },
      {
        method: 'variateImage',
        path: '/v1/images/variateImage',
        body: {
          mode: 'json',
          image_url: 'data:image/png;base64,c291cmNl',
          size: '1024x1024',
          n: 2,
          random_seed: 42,
        },
        response: generationSuccess(),
      },
      {
        method: 'crispUpscale',
        path: '/v1/images/crispUpscale',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          upscale: 'upscale4mp',
        },
        response: processSuccess(),
      },
      {
        method: 'creativeUpscale',
        path: '/v1/images/creativeUpscale',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          response_format: 'b64_json',
        },
        response: processSuccess(),
      },
    ];

    for (const testCase of cases) {
      const context = await setup(jsonResponse(testCase.response));
      await context.client[testCase.method](testCase.body);
      const wireBody = { ...testCase.body };
      delete wireBody.mode;
      expectJsonRequest(onlyRequest(context.transport), testCase.path, wireBody);
    }
  });

  it('uses exact binary keys for erase, variation, and both current upscale operations', async () => {
    const source = asset('new-source');
    const mask = asset('new-mask');
    const cases: Array<{
      method: 'eraseRegion' | 'variateImage' | 'crispUpscale' | 'creativeUpscale';
      path: string;
      body: Record<string, unknown>;
      response: unknown;
      hasMask: boolean;
    }> = [
      {
        method: 'eraseRegion',
        path: '/v1/images/eraseRegion',
        body: { mode: 'multipart', image: source, mask },
        response: processSuccess(),
        hasMask: true,
      },
      {
        method: 'variateImage',
        path: '/v1/images/variateImage',
        body: { mode: 'multipart', image: source, size: '1:1' },
        response: generationSuccess(),
        hasMask: false,
      },
      {
        method: 'crispUpscale',
        path: '/v1/images/crispUpscale',
        body: { mode: 'multipart', image: source },
        response: processSuccess(),
        hasMask: false,
      },
      {
        method: 'creativeUpscale',
        path: '/v1/images/creativeUpscale',
        body: { mode: 'multipart', image: source, expire: true },
        response: processSuccess(),
        hasMask: false,
      },
    ];

    for (const testCase of cases) {
      const context = await setup(jsonResponse(testCase.response));
      await context.client[testCase.method](testCase.body);
      const form = expectMultipartRequest(onlyRequest(context.transport), testCase.path);
      await expectAsset(form.get('image'), source);
      if (testCase.hasMask) await expectAsset(form.get('mask'), mask);
      else expect(form.has('mask')).toBe(false);
      expect(form.has('mode')).toBe(false);
    }
  });

  it('implements the non-paginated style discovery and lifecycle contract', async () => {
    const listed = await setup(jsonResponse({ styles: [styleDetailSuccess()] }));
    await expect(listed.client.listStyles()).resolves.toEqual({ styles: [styleDetailSuccess()] });
    expectNoBodyRequest(onlyRequest(listed.transport), 'GET', '/v1/styles');

    const basic = await setup(jsonResponse({ styles: [basicStyleSuccess()] }));
    await expect(basic.client.listBasicStyles()).resolves.toEqual({ styles: [basicStyleSuccess()] });
    expectNoBodyRequest(onlyRequest(basic.transport), 'GET', '/v1/styles/basic');

    const detail = await setup(jsonResponse(styleDetailSuccess()));
    await expect(detail.client.getStyle('style/id value')).resolves.toEqual(styleDetailSuccess());
    expectNoBodyRequest(onlyRequest(detail.transport), 'GET', '/v1/styles/style%2Fid%20value');

    const deleted = await setup(jsonResponse({}));
    await expect(deleted.client.deleteStyle('style/id value')).resolves.toEqual({});
    expectNoBodyRequest(onlyRequest(deleted.transport), 'DELETE', '/v1/styles/style%2Fid%20value');
  });

  it('rejects malformed style discovery, detail, and delete success payloads', async () => {
    const listed = await setup(jsonResponse({ styles: [{}] }));
    await expect(listed.client.listStyles()).rejects.toMatchObject({
      name: 'RecraftError',
      status: 200,
    });

    const basic = await setup(
      jsonResponse({ styles: [{ style_id: 'id', style: 'Vector art' }] }),
    );
    await expect(basic.client.listBasicStyles()).rejects.toMatchObject({
      name: 'RecraftError',
      status: 200,
    });

    const detail = await setup(jsonResponse({ ...styleDetailSuccess(), is_private: 'yes' }));
    await expect(detail.client.getStyle('id')).rejects.toMatchObject({
      name: 'RecraftError',
      status: 200,
    });

    const deleted = await setup(jsonResponse([]));
    await expect(deleted.client.deleteStyle('id')).rejects.toMatchObject({
      name: 'RecraftError',
      status: 200,
    });
  });

  it('serializes both prompt generation endpoints as exact JSON', async () => {
    const raster = await setup(jsonResponse(generationSuccess()));
    await expect(
      raster.client.generateRaster({
        prompt: 'raster poster',
        model: 'recraftv4_1_pro',
        size: '1024x1024',
        response_format: 'url',
        n: 2,
        controls: { no_text: true },
      }),
    ).resolves.toEqual(generationSuccess());
    expectJsonRequest(onlyRequest(raster.transport), '/v1/images/generations/raster', {
      prompt: 'raster poster',
      model: 'recraftv4_1_pro',
      size: '1024x1024',
      response_format: 'url',
      n: 2,
      controls: { no_text: true },
    });

    const vector = await setup(jsonResponse(generationSuccess()));
    await vector.client.generateVector({
      prompt: 'vector mark',
      model: 'recraftv4_1_utility_pro_vector',
      creativity: 'eccentric',
      style: 'vector_illustration',
    });
    expectJsonRequest(onlyRequest(vector.transport), '/v1/images/generations/vector', {
      prompt: 'vector mark',
      model: 'recraftv4_1_utility_pro_vector',
      creativity: 'eccentric',
      style: 'vector_illustration',
    });
  });

  it('serializes every JSON image/style operation with provider field names', async () => {
    const cases: Array<{
      method: BodyRuntimeMethod;
      path: string;
      body: Record<string, unknown>;
      response: unknown;
    }> = [
      {
        method: 'imageToImage',
        path: '/v1/images/imageToImage',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          prompt: 'ink illustration',
          strength: 0.65,
          model: 'recraftv4_1_utility',
        },
        response: generationSuccess(),
      },
      {
        method: 'inpaint',
        path: '/v1/images/inpaint',
        body: {
          mode: 'json',
          image_url: 'data:image/png;base64,c291cmNl',
          mask_url: 'data:image/png;base64,bWFzaw==',
          prompt: 'repair',
          model: 'recraftv3',
        },
        response: generationSuccess(),
      },
      {
        method: 'outpaint',
        path: '/v1/images/outpaint',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          prompt: 'extend the composition',
          expand_left: 128,
          expand_right: 64,
          model: 'recraftv3_vector',
        },
        response: generationSuccess(),
      },
      {
        method: 'replaceBackground',
        path: '/v1/images/replaceBackground',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          prompt: 'quiet studio',
          model: 'recraftv3',
        },
        response: generationSuccess(),
      },
      {
        method: 'generateBackground',
        path: '/v1/images/generateBackground',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          mask_url: 'https://assets.example/mask.png',
          prompt: 'alpine morning',
          model: 'recraftv3',
        },
        response: generationSuccess(),
      },
      {
        method: 'removeBackground',
        path: '/v1/images/removeBackground',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          response_format: 'b64_json',
        },
        response: processSuccess(),
      },
      {
        method: 'vectorize',
        path: '/v1/images/vectorize',
        body: {
          mode: 'json',
          image_url: 'https://assets.example/source.png',
          color_reduction: 'on',
          max_num_shapes: 12,
          shape_stacking: 'hierarchical',
        },
        response: processSuccess(),
      },
      {
        method: 'createStyle',
        path: '/v1/styles',
        body: {
          mode: 'json',
          style: 'digital_illustration',
          image_urls: ['https://assets.example/reference.png'],
          private: true,
          mix_policy: 'MaxWeight',
          model: 'recraftv3',
        },
        response: styleSuccess(),
      },
    ];

    for (const testCase of cases) {
      const context = await setup(jsonResponse(testCase.response));
      await context.client[testCase.method](testCase.body);
      const wireBody = { ...testCase.body };
      delete wireBody.mode;
      expectJsonRequest(onlyRequest(context.transport), testCase.path, wireBody);
    }
  });

  it('serializes transformation multipart assets, structured fields, and repeated arrays exactly', async () => {
    const source = asset('source');
    const mask = asset('mask');
    const context = await setup(jsonResponse(generationSuccess()));

    await context.client.inpaint({
      mode: 'multipart',
      image: source,
      mask,
      prompt: 'replace area',
      model: 'recraftv3',
      controls: { no_text: true, colors: [{ rgb: [1, 2, 3], weight: 0.7 }] },
      text_layout: [
        {
          text: 'ARCANA',
          bbox: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    });

    const form = expectMultipartRequest(onlyRequest(context.transport), '/v1/images/inpaint');
    await expectAsset(form.get('image'), source);
    await expectAsset(form.get('mask'), mask);
    expect(form.get('prompt')).toBe('replace area');
    expect(form.get('model')).toBe('recraftv3');
    expect(form.get('controls')).toBe(
      JSON.stringify({ no_text: true, colors: [{ rgb: [1, 2, 3], weight: 0.7 }] }),
    );
    expect(form.get('text_layout')).toBe(
      JSON.stringify([
        {
          text: 'ARCANA',
          bbox: [
            [0, 0],
            [1, 1],
          ],
        },
      ]),
    );
    expect(form.has('mode')).toBe(false);
  });

  it('uses exact multipart input keys for every other binary operation', async () => {
    const source = asset('source');
    const mask = asset('mask');
    const styleOne = asset('style-one', 'one.png');
    const styleTwo = asset('style-two', 'two.png');
    const cases: Array<{
      method: BodyRuntimeMethod;
      path: string;
      body: Record<string, unknown>;
      response: unknown;
      check(form: FormData): Promise<void> | void;
    }> = [
      {
        method: 'imageToImage',
        path: '/v1/images/imageToImage',
        body: { mode: 'multipart', image: source, prompt: 'remix', strength: 0.5 },
        response: generationSuccess(),
        check: async (form) => {
          await expectAsset(form.get('image'), source);
          expect(form.get('strength')).toBe('0.5');
        },
      },
      {
        method: 'outpaint',
        path: '/v1/images/outpaint',
        body: {
          mode: 'multipart',
          image: source,
          prompt: 'extend the composition',
          zoom_out_percentage: 25,
        },
        response: generationSuccess(),
        check: async (form) => {
          await expectAsset(form.get('image'), source);
          expect(form.get('zoom_out_percentage')).toBe('25');
        },
      },
      {
        method: 'replaceBackground',
        path: '/v1/images/replaceBackground',
        body: { mode: 'multipart', image: source, prompt: 'forest' },
        response: generationSuccess(),
        check: (form) => expect(form.get('prompt')).toBe('forest'),
      },
      {
        method: 'generateBackground',
        path: '/v1/images/generateBackground',
        body: { mode: 'multipart', image: source, mask, prompt: 'sunset' },
        response: generationSuccess(),
        check: async (form) => {
          await expectAsset(form.get('image'), source);
          await expectAsset(form.get('mask'), mask);
        },
      },
      {
        method: 'removeBackground',
        path: '/v1/images/removeBackground',
        body: { mode: 'multipart', image: source, expire: true },
        response: processSuccess(),
        check: async (form) => {
          await expectAsset(form.get('image'), source);
          expect(form.get('expire')).toBe('true');
        },
      },
      {
        method: 'vectorize',
        path: '/v1/images/vectorize',
        body: {
          mode: 'multipart',
          image: source,
          return_gradients: 'off',
          strict_color_palette: [
            [17, 34, 51],
            [68, 85, 102],
          ],
        },
        response: processSuccess(),
        check: async (form) => {
          await expectAsset(form.get('image'), source);
          expect(form.get('strict_color_palette')).toBe(
            JSON.stringify([
              [17, 34, 51],
              [68, 85, 102],
            ]),
          );
        },
      },
      {
        method: 'createStyle',
        path: '/v1/styles',
        body: {
          mode: 'multipart',
          style: 'digital_illustration',
          files: [styleOne, styleTwo],
          image_weights: [0.75, 0.25],
        },
        response: styleSuccess(),
        check: async (form) => {
          await expectAsset(form.get('file1'), styleOne);
          await expectAsset(form.get('file2'), styleTwo);
          expect(form.getAll('image_weights')).toEqual(['0.75', '0.25']);
          expect(form.has('files')).toBe(false);
        },
      },
    ];

    for (const testCase of cases) {
      const context = await setup(jsonResponse(testCase.response));
      await context.client[testCase.method](testCase.body);
      const form = expectMultipartRequest(onlyRequest(context.transport), testCase.path);
      await testCase.check(form);
      expect(form.has('mode')).toBe(false);
    }
  });

  it('accepts exact documented success minima and optional image outputs', async () => {
    const generated = {
      created: 10,
      credits: 3,
      data: [
        { image_id: 'url-image', url: 'https://signed.example/image' },
        { image_id: 'inline-image', b64_json: 'aW1hZ2U=', revised_prompt: 'revised' },
      ],
    };
    const first = await setup(jsonResponse(generated));
    await expect(first.client.generateRaster({ prompt: 'minimum' })).resolves.toEqual(generated);

    const second = await setup(jsonResponse(processSuccess()));
    await expect(
      second.client.removeBackground({ mode: 'json', image_url: 'data:image/png;base64,eA==' }),
    ).resolves.toEqual(processSuccess());

    const third = await setup(jsonResponse(styleSuccess()));
    await expect(
      third.client.createStyle({
        mode: 'json',
        style: 'digital_illustration',
        image_urls: ['data:image/png;base64,eA=='],
      }),
    ).resolves.toEqual(styleSuccess());

    const sourceStyle = await setup(jsonResponse(styleSuccess()));
    await sourceStyle.client.createStyle({
      mode: 'json',
      style: 'digital_illustration',
      source_styles: ['00000000-0000-0000-0000-000000000004'],
    });
    expectJsonRequest(onlyRequest(sourceStyle.transport), '/v1/styles', {
      style: 'digital_illustration',
      source_styles: ['00000000-0000-0000-0000-000000000004'],
    });
  });

  it.each([
    [{ credits: 1, data: [] }, 'GenerateImageResponse'],
    [{ created: 1, credits: '1', data: [{ image_id: 'x' }] }, 'GenerateImageResponse'],
    [{ created: 1, credits: 1, data: [{}] }, 'GenerateImageResponse'],
    [{ created: 1, credits: 1, data: [{ image_id: 'x', url: 42 }] }, 'GenerateImageResponse'],
    [
      {
        created: 1,
        credits: 1,
        data: [{ image_id: 'x', features: { nsfw_score: 'unknown' } }],
      },
      'GenerateImageResponse',
    ],
  ])('rejects malformed generation success payload %j', async (body, schema) => {
    const { client } = await setup(jsonResponse(body));
    const caught = await client
      .generateRaster({ prompt: 'invalid response' })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(caught).toMatchObject({ name: 'RecraftError', status: 200, parsedBody: body });
    expect(caught).toBeInstanceOf(RecraftError);
    expect(String(caught)).toContain(schema);
  });

  it('rejects malformed process and style success payloads', async () => {
    const process = await setup(jsonResponse({ created: 1, credits: 1, image: {} }));
    await expect(
      process.client.removeBackground({ mode: 'json', image_url: 'https://assets.example/x' }),
    ).rejects.toMatchObject({ name: 'RecraftError', status: 200 });

    const style = await setup(
      jsonResponse({ id: 'style-id', name: 'invented-field', credits: '4' }),
    );
    await expect(
      style.client.createStyle({
        mode: 'json',
        style: 'digital_illustration',
        image_urls: ['https://assets.example/x'],
      }),
    ).rejects.toMatchObject({ name: 'RecraftError', status: 200 });
  });

  it.each([
    [
      400,
      JSON.stringify({ error: { arbitrary: 'bad request' } }),
      { error: { arbitrary: 'bad request' } },
    ],
    [401, 'not authorized', 'not authorized'],
    [429, '', ''],
    [503, '<html>unavailable</html>', '<html>unavailable</html>'],
  ])(
    'preserves exact HTTP %i body without inventing provider fields',
    async (status, raw, parsed) => {
      const response = raw.startsWith('{')
        ? jsonResponse(JSON.parse(raw), status)
        : textResponse(raw, status);
      const { client } = await setup(response);
      const caught = await client
        .generateVector({ prompt: 'error path' })
        .then(() => undefined)
        .catch((error: unknown) => error);

      expect(caught).toMatchObject({
        name: 'RecraftError',
        status,
        rawBody: raw,
        parsedBody: parsed,
      });
      expect(caught).toBeInstanceOf(RecraftError);
      expect(JSON.stringify(caught)).not.toContain('offline-recraft-token');
      expect(String(caught)).not.toContain('offline-recraft-token');
    },
  );

  it('keeps the token non-enumerable and never dereferences user asset URLs', async () => {
    const context = await setup(jsonResponse(generationSuccess()));
    expect(Object.keys(context.client)).not.toContain('apiToken');
    expect(JSON.stringify(context.client)).not.toContain('offline-recraft-token');

    await context.client.imageToImage({
      mode: 'json',
      image_url: 'http://127.0.0.1/private-image',
      prompt: 'forward only',
      strength: 0.4,
    });
    expect(context.transport.requests).toHaveLength(1);
    expect(String(context.transport.requests[0].input)).toBe(
      'https://external.api.recraft.ai/v1/images/imageToImage',
    );
    expect(context.transport.requests[0].init?.body).toContain('http://127.0.0.1/private-image');
  });
});

function compileTimeContract(client: RecraftClient): void {
  void client.generateRaster({ prompt: 'ok', model: 'recraftv4_1_utility_pro' });
  void client.generateVector({ prompt: 'ok', model: 'recraftv4_1_pro_vector' });
  void client.generate({
    prompt: 'ok',
    model: 'recraftv4_1_utility_pro_vector',
    billing: 'subscription',
  });
  void client.eraseRegion({
    mode: 'json',
    image_url: 'data:image/png;base64,eA==',
    mask_url: 'data:image/png;base64,eA==',
  });
  void client.variateImage({
    mode: 'multipart',
    image: asset('compile-variation'),
    size: '1:1',
  });
  void client.explore({ prompt: 'ok', model: 'recraftv4_pro_vector' });
  void client.exploreSimilar({ source_image_id: 'style-id', similarity: 3 });
  void client.crispUpscale({
    mode: 'json',
    image_url: 'data:image/png;base64,eA==',
  });
  void client.creativeUpscale({ mode: 'multipart', image: asset('compile-upscale') });
  void client.listStyles();
  void client.listBasicStyles();
  void client.getStyle('style-id');
  void client.deleteStyle('style-id');
  void client
    .createStyle({
      mode: 'json',
      style: 'digital_illustration',
      image_urls: ['data:image/png;base64,eA=='],
    })
    .then((response) => {
      const substyle: RecraftImageSubStyle | undefined = response.substyle;
      return substyle;
    });
  void client.imageToImage({
    mode: 'json',
    image_url: 'data:image/png;base64,eA==',
    prompt: 'ok',
    strength: 0.5,
    model: 'recraftv4_1_utility_pro_vector',
  });
  void client.outpaint({
    mode: 'json',
    image_url: 'data:image/png;base64,eA==',
    prompt: 'ok',
    size: '1024x1024',
  });
  void client.createStyle({
    mode: 'json',
    style: 'digital_illustration',
    source_styles: ['00000000-0000-0000-0000-000000000004'],
  });

  // @ts-expect-error third-party OpenAPI values are outside AU-017
  void client.generateRaster({ prompt: 'wrong', model: 'flux1_1_pro' });
  // @ts-expect-error vector models cannot be sent to the raster endpoint
  void client.generateRaster({ prompt: 'wrong', model: 'recraftv4_vector' });
  void client.inpaint({
    mode: 'json',
    image_url: 'data:image/png;base64,eA==',
    mask_url: 'data:image/png;base64,eA==',
    prompt: 'wrong',
    // @ts-expect-error edit operations do not document V4/V4.1 models
    model: 'recraftv4_1',
  });
  // @ts-expect-error style and style_id are mutually exclusive
  void client.generateRaster({ prompt: 'wrong', style: 'any', style_id: 'style-id' });
  // @ts-expect-error outpaint requires size, zoom, or at least one explicit expansion
  void client.outpaint({ mode: 'json', image_url: 'data:image/png;base64,eA==', prompt: 'wrong' });
  // @ts-expect-error size is mutually exclusive with explicit pixel expansion
  void client.outpaint({
    mode: 'json',
    image_url: 'data:image/png;base64,eA==',
    prompt: 'wrong',
    size: '1024x1024',
    expand_left: 64,
  });
  // @ts-expect-error style creation needs image inputs or at least one source style
  void client.createStyle({ mode: 'json', style: 'digital_illustration', source_styles: [] });
  // @ts-expect-error generic generation excludes third-party model aliases
  void client.generate({ prompt: 'wrong', model: 'flux1dev' });
  // @ts-expect-error explore supports only its documented Recraft V4 family
  void client.explore({ prompt: 'wrong', model: 'recraftv3' });
  // @ts-expect-error erase requires both image and mask inputs
  void client.eraseRegion({ mode: 'json', image_url: 'data:image/png;base64,eA==' });
  // @ts-expect-error variation requires a target size
  void client.variateImage({
    mode: 'json',
    image_url: 'data:image/png;base64,eA==',
  });
  // @ts-expect-error exploration is JSON-only
  void client.explore({ mode: 'multipart', image: asset('wrong'), prompt: 'wrong' });
  // @ts-expect-error style listing has no pagination input
  void client.listStyles({ cursor: 'not-supported' });
  // @ts-expect-error deprecated operation is deliberately non-callable
  void client.clarityUpscale({ mode: 'multipart', image: asset('wrong') });
  // @ts-expect-error deprecated operation is deliberately non-callable
  void client.generativeUpscale({ mode: 'multipart', image: asset('wrong') });
}

void compileTimeContract;
