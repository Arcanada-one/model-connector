import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NovaMediaConnector, NovaMediaHttpError } from './nova-media.connector';
import { bedrockRuntimeEndpoint } from './nova-media.contract';
import {
  type BedrockHttpRequest,
  type BedrockHttpResponse,
  type BedrockSigner,
  type BedrockTransport,
  type CanvasInvokeInput,
  type ReelModelInput,
} from './nova-media.types';

interface CanvasFixture {
  modelId: 'amazon.nova-canvas-v1:0';
  region: string;
  tasks: Array<{ name: string; input: CanvasInvokeInput }>;
  successResponse: unknown;
  partialFilterResponse: { images: string[]; error: string };
  bedrockError: unknown;
}

interface ReelFixture {
  region: string;
  invocationArn: string;
  starts: Array<{
    name: string;
    modelId: 'amazon.nova-reel-v1:0' | 'amazon.nova-reel-v1:1';
    modelInput: ReelModelInput;
  }>;
  outputDataConfig: Record<string, unknown>;
  startResponse: unknown;
  getResponses: Record<'inProgress' | 'completed' | 'failed', unknown>;
  listResponse: unknown;
  outputSuccess: unknown;
  outputFailure: unknown;
}

function loadFixture<T>(name: string): T {
  const path = join(__dirname, '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const canvas = loadFixture<CanvasFixture>('canvas.json');
const reel = loadFixture<ReelFixture>('reel.json');

describe('NovaMediaConnector', () => {
  let response: BedrockHttpResponse;
  let signer: BedrockSigner;
  let transport: BedrockTransport;
  let connector: NovaMediaConnector;
  let sent: BedrockHttpRequest[];
  let order: string[];

  beforeEach(() => {
    response = { status: 200, headers: {}, body: '{}' };
    sent = [];
    order = [];
    signer = {
      sign: vi.fn(async (request) => {
        order.push('sign');
        return { ...request, headers: { ...request.headers, authorization: 'synthetic' } };
      }),
    };
    transport = {
      send: vi.fn(async (request) => {
        order.push('send');
        sent.push(request);
        return response;
      }),
    };
    connector = new NovaMediaConnector(signer, transport);
  });

  describe('Canvas InvokeModel', () => {
    it('constructs documented partition DNS suffixes independently of model availability', () => {
      expect(bedrockRuntimeEndpoint('us-east-1', 'aws')).toBe(
        'https://bedrock-runtime.us-east-1.amazonaws.com',
      );
      expect(bedrockRuntimeEndpoint('cn-north-1', 'aws-cn')).toBe(
        'https://bedrock-runtime.cn-north-1.amazonaws.com.cn',
      );
      expect(bedrockRuntimeEndpoint('us-gov-west-1', 'aws-us-gov')).toBe(
        'https://bedrock-runtime.us-gov-west-1.amazonaws.com',
      );
    });

    it.each(canvas.tasks)('serializes $name without reshaping native fields', async ({ input }) => {
      response = { status: 200, headers: {}, body: JSON.stringify(canvas.successResponse) };

      const result = await connector.invokeCanvas({
        region: canvas.region,
        modelId: canvas.modelId,
        input,
      });

      expect(result).toEqual(canvas.successResponse);
      expect(order).toEqual(['sign', 'send']);
      expect(sent[0]).toMatchObject({
        method: 'POST',
        url: `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(
          canvas.modelId,
        )}/invoke`,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: 'synthetic',
        },
        body: JSON.stringify(input),
      });
      expect(signer.sign).toHaveBeenCalledWith(
        expect.objectContaining({ body: JSON.stringify(input) }),
        { service: 'bedrock', region: 'us-east-1' },
      );
    });

    it('preserves an HTTP-200 responsible-AI partial result', async () => {
      response = { status: 200, headers: {}, body: JSON.stringify(canvas.partialFilterResponse) };
      const result = await connector.invokeCanvas({
        region: canvas.region,
        modelId: canvas.modelId,
        input: canvas.tasks[0].input,
      });
      expect(result).toEqual(canvas.partialFilterResponse);
    });

    it('rejects invalid generation dimensions before signing', async () => {
      const input = structuredClone(canvas.tasks[0].input);
      if (input.taskType === 'TEXT_IMAGE' && input.imageGenerationConfig) {
        input.imageGenerationConfig.width = 321;
      }
      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/divisible by 16/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('rejects documented config range violations before signing', async () => {
      const badScale = structuredClone(canvas.tasks[0].input);
      const badSeed = structuredClone(canvas.tasks[0].input);
      const badCount = structuredClone(canvas.tasks[0].input);
      if (
        badScale.taskType !== 'TEXT_IMAGE' ||
        badSeed.taskType !== 'TEXT_IMAGE' ||
        badCount.taskType !== 'TEXT_IMAGE'
      ) {
        throw new Error('fixture task mismatch');
      }
      badScale.imageGenerationConfig = { cfgScale: 1 };
      badSeed.imageGenerationConfig = { seed: 2_147_483_647 };
      badCount.imageGenerationConfig = { numberOfImages: 6 };

      for (const input of [badScale, badSeed, badCount]) {
        await expect(
          connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
        ).rejects.toThrow(/cfgScale|seed|numberOfImages/);
      }
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it.each([
      { taskIndex: 0, paramsKey: 'textToImageParams' },
      { taskIndex: 1, paramsKey: 'colorGuidedGenerationParams' },
    ])('requires the documented prompt for $paramsKey', async ({ taskIndex, paramsKey }) => {
      const input = structuredClone(canvas.tasks[taskIndex].input);
      const inputRecord = input as unknown as Record<string, unknown>;
      const params = inputRecord[paramsKey] as Record<string, unknown>;
      delete params.text;

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/text.*1-1024/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it.each([
      { field: 'controlMode', value: 'CANNY_EDGE' },
      { field: 'controlStrength', value: 0.7 },
    ])('requires conditionImage when TEXT_IMAGE supplies $field', async ({ field, value }) => {
      const input = structuredClone(canvas.tasks[0].input);
      if (input.taskType !== 'TEXT_IMAGE') throw new Error('fixture task mismatch');
      const params = input.textToImageParams as unknown as Record<string, unknown>;
      params[field] = value;
      delete params.conditionImage;

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/conditionImage/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('validates a supplied empty conditionImage before signing', async () => {
      const input = structuredClone(canvas.tasks[0].input);
      if (input.taskType !== 'TEXT_IMAGE') throw new Error('fixture task mismatch');
      input.textToImageParams.conditionImage = '';

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/conditionImage.*1-/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('requires maskPrompt for a PROMPT virtual try-on mask', async () => {
      const input = structuredClone(canvas.tasks[6].input);
      if (input.taskType !== 'VIRTUAL_TRY_ON') throw new Error('fixture task mismatch');
      const params = input.virtualTryOnParams as unknown as Record<string, unknown>;
      params.maskType = 'PROMPT';
      delete params.garmentBasedMask;
      params.promptBasedMask = {};

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/maskPrompt.*1-1024/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it.each([
      {
        target: 'virtualTryOnParams',
        mutate: (params: Record<string, unknown>) => {
          params.unexpected = true;
        },
      },
      {
        target: 'imageBasedMask',
        mutate: (params: Record<string, unknown>) => {
          params.maskType = 'IMAGE';
          delete params.garmentBasedMask;
          params.imageBasedMask = { maskImage: 'iVBORw0KGgo=', unexpected: true };
        },
      },
      {
        target: 'garmentBasedMask',
        mutate: (params: Record<string, unknown>) => {
          (params.garmentBasedMask as Record<string, unknown>).unexpected = true;
        },
      },
      {
        target: 'promptBasedMask',
        mutate: (params: Record<string, unknown>) => {
          params.maskType = 'PROMPT';
          delete params.garmentBasedMask;
          params.promptBasedMask = { maskPrompt: 'upper garment', unexpected: true };
        },
      },
      {
        target: 'garmentStyling',
        mutate: (params: Record<string, unknown>) => {
          const garment = params.garmentBasedMask as Record<string, unknown>;
          (garment.garmentStyling as Record<string, unknown>).unexpected = true;
        },
      },
      {
        target: 'maskExclusions',
        mutate: (params: Record<string, unknown>) => {
          (params.maskExclusions as Record<string, unknown>).unexpected = true;
        },
      },
    ])('closes the documented $target object', async ({ mutate }) => {
      const input = structuredClone(canvas.tasks[6].input);
      if (input.taskType !== 'VIRTUAL_TRY_ON') throw new Error('fixture task mismatch');
      mutate(input.virtualTryOnParams as unknown as Record<string, unknown>);

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/unsupported field/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('requires returnMask to be boolean when supplied', async () => {
      const input = structuredClone(canvas.tasks[6].input);
      if (input.taskType !== 'VIRTUAL_TRY_ON') throw new Error('fixture task mismatch');
      const params = input.virtualTryOnParams as unknown as Record<string, unknown>;
      params.returnMask = 'true';

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/returnMask.*boolean/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it.each([
      { field: 'longSleeveStyle', value: 'DOWN' },
      { field: 'tuckingStyle', value: 'HALF_TUCKED' },
      { field: 'outerLayerStyle', value: 'ZIPPED' },
    ])('validates garmentStyling.$field', async ({ field, value }) => {
      const input = structuredClone(canvas.tasks[6].input);
      if (input.taskType !== 'VIRTUAL_TRY_ON') throw new Error('fixture task mismatch');
      const params = input.virtualTryOnParams as unknown as Record<string, unknown>;
      const garment = params.garmentBasedMask as Record<string, unknown>;
      const styling = garment.garmentStyling as Record<string, unknown>;
      styling[field] = value;

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(new RegExp(field));
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('rejects invalid color, variation count, and virtual mask selection', async () => {
      const color = structuredClone(canvas.tasks[1].input);
      const variation = structuredClone(canvas.tasks[2].input);
      const virtual = structuredClone(canvas.tasks[6].input);
      if (
        color.taskType !== 'COLOR_GUIDED_GENERATION' ||
        variation.taskType !== 'IMAGE_VARIATION' ||
        virtual.taskType !== 'VIRTUAL_TRY_ON'
      ) {
        throw new Error('fixture task mismatch');
      }
      color.colorGuidedGenerationParams.colors = ['orange'];
      variation.imageVariationParams.images = Array.from({ length: 6 }, () => 'iVBORw0KGgo=');
      virtual.virtualTryOnParams.imageBasedMask = { maskImage: 'iVBORw0KGgo=' };

      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input: color }),
      ).rejects.toThrow(/#RRGGBB/);
      await expect(
        connector.invokeCanvas({
          region: canvas.region,
          modelId: canvas.modelId,
          input: variation,
        }),
      ).rejects.toThrow(/1-5 images/);
      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input: virtual }),
      ).rejects.toThrow(/exactly one mask object/);
    });

    it('rejects both inpainting mask forms before signing', async () => {
      const input = structuredClone(canvas.tasks[3].input);
      if (input.taskType === 'INPAINTING') {
        input.inPaintingParams.maskImage = 'iVBORw0KGgo=';
      }
      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/exactly one/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('rejects a generation config for background removal', async () => {
      const input = {
        ...canvas.tasks[5].input,
        imageGenerationConfig: { numberOfImages: 1 },
      } as CanvasInvokeInput;
      await expect(
        connector.invokeCanvas({ region: canvas.region, modelId: canvas.modelId, input }),
      ).rejects.toThrow(/generation config/i);
    });

    it('rejects an unsupported region and partition', async () => {
      await expect(
        connector.invokeCanvas({
          region: 'us-west-2',
          modelId: canvas.modelId,
          input: canvas.tasks[0].input,
        }),
      ).rejects.toThrow(/region/i);
      await expect(
        connector.invokeCanvas({
          partition: 'aws-cn',
          region: canvas.region,
          modelId: canvas.modelId,
          input: canvas.tasks[0].input,
        }),
      ).rejects.toThrow(/partition/i);
    });

    it('preserves Bedrock HTTP error type and status without signed headers', async () => {
      response = { status: 400, headers: {}, body: JSON.stringify(canvas.bedrockError) };
      const error = await connector
        .invokeCanvas({
          region: canvas.region,
          modelId: canvas.modelId,
          input: canvas.tasks[0].input,
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NovaMediaHttpError);
      expect(error).toMatchObject({ status: 400, providerType: 'ValidationException' });
      expect(JSON.stringify(error)).not.toContain('synthetic');
    });
  });

  describe('Reel async lifecycle', () => {
    it.each(reel.starts)('starts $name with the native async body', async (start) => {
      response = { status: 200, headers: {}, body: JSON.stringify(reel.startResponse) };
      const result = await connector.startReel({
        region: reel.region,
        modelId: start.modelId,
        modelInput: start.modelInput,
        outputDataConfig: reel.outputDataConfig,
        clientRequestToken: 'request-123',
      });
      expect(result).toEqual(reel.startResponse);
      expect(JSON.parse(sent[0].body ?? '{}')).toEqual({
        clientRequestToken: 'request-123',
        modelId: start.modelId,
        modelInput: start.modelInput,
        outputDataConfig: reel.outputDataConfig,
      });
      expect(sent[0].url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/async-invoke');
    });

    it.each([
      { name: 'unknown member', tag: { key: 'team', value: 'media', unexpected: true } },
      { name: 'missing key', tag: { value: 'media' } },
      { name: 'missing value', tag: { key: 'team' } },
      { name: 'empty key', tag: { key: '', value: 'media' } },
      { name: 'oversized key', tag: { key: 'k'.repeat(129), value: 'media' } },
      { name: 'oversized value', tag: { key: 'team', value: 'v'.repeat(257) } },
      { name: 'invalid key characters', tag: { key: 'team?', value: 'media' } },
      { name: 'invalid value characters', tag: { key: 'team', value: 'media?' } },
    ])('rejects a tag with $name before signing', async ({ tag }) => {
      await expect(
        connector.startReel({
          region: reel.region,
          modelId: reel.starts[0].modelId,
          modelInput: reel.starts[0].modelInput,
          outputDataConfig: reel.outputDataConfig,
          tags: [tag] as Array<{ key: string; value: string }>,
        }),
      ).rejects.toThrow(/tag/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('accepts documented tag characters and an empty value', async () => {
      response = { status: 200, headers: {}, body: JSON.stringify(reel.startResponse) };
      const tags = [{ key: 'Team 1._:/=+@-', value: '' }];

      await connector.startReel({
        region: reel.region,
        modelId: reel.starts[0].modelId,
        modelInput: reel.starts[0].modelInput,
        outputDataConfig: reel.outputDataConfig,
        tags,
      });

      expect(JSON.parse(sent[0].body ?? '{}')).toMatchObject({ tags });
    });

    it('rejects multi-shot on Reel 1.0 and Reel 1.1 outside us-east-1', async () => {
      await expect(
        connector.startReel({
          region: reel.region,
          modelId: 'amazon.nova-reel-v1:0',
          modelInput: reel.starts[1].modelInput,
          outputDataConfig: reel.outputDataConfig,
        }),
      ).rejects.toThrow(/1:1/i);
      await expect(
        connector.startReel({
          region: 'eu-west-1',
          modelId: 'amazon.nova-reel-v1:1',
          modelInput: reel.starts[1].modelInput,
          outputDataConfig: reel.outputDataConfig,
        }),
      ).rejects.toThrow(/region/i);
    });

    it('rejects invalid duration, image count, seed, and S3 output owner', async () => {
      const automated = structuredClone(reel.starts[1].modelInput);
      if (automated.taskType === 'MULTI_SHOT_AUTOMATED')
        automated.videoGenerationConfig.durationSeconds = 13;
      await expect(
        connector.startReel({
          region: reel.region,
          modelId: reel.starts[1].modelId,
          modelInput: automated,
          outputDataConfig: reel.outputDataConfig,
        }),
      ).rejects.toThrow(/multiple of 6/i);

      const textVideo = structuredClone(reel.starts[0].modelInput);
      if (textVideo.taskType === 'TEXT_VIDEO') {
        textVideo.textToVideoParams.images = [
          ...(textVideo.textToVideoParams.images ?? []),
          { format: 'png', source: { bytes: 'iVBORw0KGgo=' } },
        ];
      }
      await expect(
        connector.startReel({
          region: reel.region,
          modelId: reel.starts[0].modelId,
          modelInput: textVideo,
          outputDataConfig: reel.outputDataConfig,
        }),
      ).rejects.toThrow(/one image/i);

      const badOutput = {
        s3OutputDataConfig: { s3Uri: 's3://bucket/prefix', bucketOwner: '123' },
      };
      await expect(
        connector.startReel({
          region: reel.region,
          modelId: reel.starts[0].modelId,
          modelInput: reel.starts[0].modelInput,
          outputDataConfig: badOutput,
        }),
      ).rejects.toThrow(/12 digits/i);
    });

    it.each(['inProgress', 'completed', 'failed'] as const)(
      'gets the %s Bedrock invocation status',
      async (state) => {
        response = { status: 200, headers: {}, body: JSON.stringify(reel.getResponses[state]) };
        const result = await connector.getReel({
          region: reel.region,
          invocationArn: reel.invocationArn,
        });
        expect(result).toEqual(reel.getResponses[state]);
        expect(sent[0].method).toBe('GET');
        expect(sent[0].body).toBeUndefined();
        expect(sent[0].url).toBe(
          `https://bedrock-runtime.us-east-1.amazonaws.com/async-invoke/${encodeURIComponent(
            reel.invocationArn,
          )}`,
        );
      },
    );

    it('lists with documented filters and preserves pagination', async () => {
      response = { status: 200, headers: {}, body: JSON.stringify(reel.listResponse) };
      const result = await connector.listReel({
        region: reel.region,
        maxResults: 1000,
        nextToken: 'page-1',
        sortBy: 'SubmissionTime',
        sortOrder: 'Descending',
        statusEquals: 'Completed',
        submitTimeAfter: '2026-07-24T00:00:00Z',
        submitTimeBefore: '2026-07-25T00:00:00Z',
      });
      expect(result).toEqual(reel.listResponse);
      const url = new URL(sent[0].url);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        maxResults: '1000',
        nextToken: 'page-1',
        sortBy: 'SubmissionTime',
        sortOrder: 'Descending',
        statusEquals: 'Completed',
        submitTimeAfter: '2026-07-24T00:00:00Z',
        submitTimeBefore: '2026-07-25T00:00:00Z',
      });
    });

    it('accepts a list summary without optional status', async () => {
      const listResponse = structuredClone(reel.listResponse) as {
        asyncInvokeSummaries: Array<Record<string, unknown>>;
      };
      delete listResponse.asyncInvokeSummaries[0].status;
      response = { status: 200, headers: {}, body: JSON.stringify(listResponse) };

      await expect(connector.listReel({ region: reel.region })).resolves.toEqual(listResponse);
    });

    it('strictly validates list status when present', async () => {
      const listResponse = structuredClone(reel.listResponse) as {
        asyncInvokeSummaries: Array<Record<string, unknown>>;
      };
      listResponse.asyncInvokeSummaries[0].status = 'Unknown';
      response = { status: 200, headers: {}, body: JSON.stringify(listResponse) };

      await expect(connector.listReel({ region: reel.region })).rejects.toThrow(/status/i);
    });

    it('still requires status in GetAsyncInvoke responses', async () => {
      const getResponse = structuredClone(reel.getResponses.completed) as Record<string, unknown>;
      delete getResponse.status;
      response = { status: 200, headers: {}, body: JSON.stringify(getResponse) };

      await expect(
        connector.getReel({ region: reel.region, invocationArn: reel.invocationArn }),
      ).rejects.toThrow(/status/i);
    });

    it('rejects invalid pagination and invocation identifiers before signing', async () => {
      await expect(connector.listReel({ region: reel.region, maxResults: 1001 })).rejects.toThrow(
        /1 through 1000/,
      );
      await expect(
        connector.listReel({ region: reel.region, nextToken: 'not valid' }),
      ).rejects.toThrow(/whitespace/);
      await expect(
        connector.getReel({ region: reel.region, invocationArn: 'not-an-arn' }),
      ).rejects.toThrow(/invocation ARN/i);
      expect(signer.sign).not.toHaveBeenCalled();
    });

    it('validates supplied success and failure output metadata without transport', () => {
      expect(connector.parseReelOutput(reel.outputSuccess)).toEqual(reel.outputSuccess);
      expect(connector.parseReelOutput(reel.outputFailure)).toEqual(reel.outputFailure);
      expect(transport.send).not.toHaveBeenCalled();
    });

    it('rejects a failed full video that claims a location', () => {
      const invalid = structuredClone(reel.outputFailure) as {
        fullVideo: { location?: string };
      };
      invalid.fullVideo.location = 's3://output-bucket/nova-reel/output.mp4';
      expect(() => connector.parseReelOutput(invalid)).toThrow(/failed.*location/i);
    });
  });

  it('advertises only AU-047 models and media modalities', () => {
    expect(connector.getCapabilities()).toMatchObject({
      name: 'bedrock-nova-media',
      type: 'api',
      models: ['amazon.nova-canvas-v1:0', 'amazon.nova-reel-v1:0', 'amazon.nova-reel-v1:1'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
    });
    expect(connector.getCapabilities().modelMeta).toEqual([
      { id: 'amazon.nova-canvas-v1:0', modality: 'image_generation' },
      { id: 'amazon.nova-reel-v1:0', modality: 'video' },
      { id: 'amazon.nova-reel-v1:1', modality: 'video' },
    ]);
  });

  it('fails closed without injected signing and transport', async () => {
    const unwired = new NovaMediaConnector();
    const result = await unwired.execute({
      prompt: 'unused',
      model: canvas.modelId,
      extra: { operation: 'canvas.invoke', region: canvas.region, input: canvas.tasks[0].input },
    });
    expect(result).toMatchObject({
      connector: 'bedrock-nova-media',
      status: 'error',
      error: { type: 'not_configured', retryable: false },
    });
  });
});
