import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RecordedHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface RecordedStreamCall {
  endpoint: string;
  service: string;
  method: string;
  metadata: Record<string, string>;
  requests: unknown[];
}

export class RecordingHttpTransport {
  readonly requests: RecordedHttpRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async request(request: RecordedHttpRequest): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }> {
    this.requests.push(request);
    const body = this.responses.shift();
    if (body === undefined) {
      throw new Error('No synthetic HTTP fixture response remains');
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body };
  }
}

export class RecordingStreamingTransport {
  readonly calls: RecordedStreamCall[] = [];

  constructor(private readonly responses: unknown[]) {}

  stream(input: {
    endpoint: string;
    service: string;
    method: string;
    metadata: Record<string, string>;
    requests: AsyncIterable<unknown>;
  }): AsyncIterable<unknown> {
    const calls = this.calls;
    const responses = this.responses;
    return (async function* recordAndReplay() {
      const requests: unknown[] = [];
      for await (const request of input.requests) {
        requests.push(request);
      }
      calls.push({ ...input, requests });
      for (const response of responses) {
        yield response;
      }
    })();
  }
}

export async function* frames<T>(values: T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}

export async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, name), 'utf8')) as T;
}
