import { LeonardoProtocolError } from './leonardo-ai.error';
import type { LeonardoInitImageAssetInput } from './leonardo-ai.types';

const encoder = new TextEncoder();

const encode = (value: string): Uint8Array => encoder.encode(value);

const concatenate = (parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const assertSafeHeaderValue = (name: string, value: string): void => {
  if (value.length === 0 || /[\r\n"]/.test(value)) {
    throw new LeonardoProtocolError(`invalid multipart ${name}`);
  }
};

export const parsePresignedFields = (fields: string): Readonly<Record<string, string>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fields);
  } catch {
    throw new LeonardoProtocolError('init-image fields is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LeonardoProtocolError('init-image fields must be an object');
  }

  const entries = Object.entries(parsed);
  for (const [name, value] of entries) {
    assertSafeHeaderValue('field name', name);
    if (typeof value !== 'string') {
      throw new LeonardoProtocolError('init-image fields values must be strings');
    }
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
};

export const encodeMultipart = (
  fields: Readonly<Record<string, string>>,
  file: LeonardoInitImageAssetInput,
  boundary: string,
): Uint8Array => {
  assertSafeHeaderValue('boundary', boundary);
  assertSafeHeaderValue('filename', file.filename);
  assertSafeHeaderValue('media type', file.mediaType);

  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    assertSafeHeaderValue('field name', name);
    parts.push(
      encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
      ),
    );
  }
  parts.push(
    encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.mediaType}\r\n\r\n`,
    ),
    file.bytes,
    encode(`\r\n--${boundary}--\r\n`),
  );
  return concatenate(parts);
};
