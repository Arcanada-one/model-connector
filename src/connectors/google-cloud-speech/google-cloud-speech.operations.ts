import {
  GoogleCloudSpeechOperationError,
  assertSuccessfulResponse,
} from './google-cloud-speech.errors';
import {
  speechV1Endpoint,
  speechV2Endpoint,
  textToSpeechEndpoint,
} from './google-cloud-speech.endpoints';
import { googleLongRunningOperationSchema } from './google-cloud-speech.schemas';
import type { GoogleSpeechHttpTransport } from './google-cloud-speech.transport';
import type {
  GoogleAuthHeadersProvider,
  GoogleLongRunningOperation,
  GoogleSpeechOperationReference,
} from './google-cloud-speech.types';
import { locationFromResource } from './google-cloud-speech.validation';

export { GoogleCloudSpeechOperationError } from './google-cloud-speech.errors';

interface OperationsClientOptions {
  auth: GoogleAuthHeadersProvider;
  httpTransport: GoogleSpeechHttpTransport;
}

interface OperationRoute {
  endpoint: string;
  version: 'v1' | 'v2' | 'v1beta1';
  name: string;
}

const REGIONAL_OPERATION_PATTERN =
  /^projects\/[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}\/locations\/[a-z][a-z0-9-]{0,62}\/operations\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const SAFE_OPERATION_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export class GoogleCloudSpeechOperationsClient {
  private readonly auth: GoogleAuthHeadersProvider;
  private readonly httpTransport: GoogleSpeechHttpTransport;

  constructor(options: OperationsClientOptions) {
    this.auth = options.auth;
    this.httpTransport = options.httpTransport;
  }

  async getOperation(
    reference: GoogleSpeechOperationReference,
  ): Promise<GoogleLongRunningOperation> {
    const route = operationRoute(reference);
    const response = await this.httpTransport.request({
      method: 'GET',
      url: `https://${route.endpoint}/${route.version}/${route.name}`,
      headers: await this.auth.getRequestHeaders(),
    });
    const operation = googleLongRunningOperationSchema.parse(assertSuccessfulResponse(response));
    if (operation.error) {
      throw new GoogleCloudSpeechOperationError(operation.error);
    }
    return operation as GoogleLongRunningOperation;
  }

  async cancelOperation(reference: GoogleSpeechOperationReference): Promise<Record<string, never>> {
    const route = operationRoute(reference);
    const response = await this.httpTransport.request({
      method: 'POST',
      url: `https://${route.endpoint}/${route.version}/${route.name}:cancel`,
      headers: {
        ...(await this.auth.getRequestHeaders()),
        'content-type': 'application/json',
      },
      body: {},
    });
    assertSuccessfulResponse(response);
    return {};
  }
}

function operationRoute(reference: GoogleSpeechOperationReference): OperationRoute {
  if (reference.api === 'speech-v1') {
    if (!isSafeV1OperationName(reference.name)) {
      throw new Error('speech-v1 operation name must match operations/**');
    }
    return {
      endpoint: speechV1Endpoint(reference.location ?? 'global'),
      version: 'v1',
      name: reference.name,
    };
  }
  if (!REGIONAL_OPERATION_PATTERN.test(reference.name)) {
    throw new Error(`${reference.api} operation name must be a regional operation resource`);
  }
  const location = locationFromResource(
    reference.name.replace(/\/operations\/[^/]+$/, ''),
    'parent',
  );
  if (reference.location !== undefined && reference.location !== location) {
    throw new Error(
      `operation location ${location} does not match selected endpoint ${reference.location}`,
    );
  }
  if (reference.api === 'speech-v2') {
    return { endpoint: speechV2Endpoint(location), version: 'v2', name: reference.name };
  }
  return {
    endpoint: textToSpeechEndpoint(location),
    version: reference.api === 'tts-v1' ? 'v1' : 'v1beta1',
    name: reference.name,
  };
}

function isSafeV1OperationName(name: string): boolean {
  const segments = name.split('/');
  return (
    segments[0] === 'operations' &&
    segments.length >= 2 &&
    segments.slice(1).every((segment) => {
      return segment !== '.' && segment !== '..' && SAFE_OPERATION_SEGMENT.test(segment);
    })
  );
}
