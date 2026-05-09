/**
 * Integration test: R2StorageService — real upload + presigned URL + fetch + cleanup.
 * Gate: RUN_INTEGRATION=1
 * Cost: ~$0 (R2 free tier: 10GB storage, 1M Class B ops/month)
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { R2StorageService } from './r2.service';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';

const shouldRun = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!shouldRun)('R2StorageService [INTEGRATION]', () => {
  let service: R2StorageService;
  let s3Client: S3Client;
  const uploadedKeys: string[] = [];

  const accountId = process.env.R2_ACCOUNT_ID ?? '';
  const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? '';
  const bucket = process.env.R2_BUCKET ?? 'arcanada-mc-images';
  const endpoint = process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`;

  beforeAll(() => {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set — load .env.integration');
    }
    service = new R2StorageService(accountId, accessKeyId, secretAccessKey, bucket, endpoint);

    // Direct S3 client for cleanup
    s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  });

  afterAll(async () => {
    // Cleanup: delete all objects uploaded during tests
    for (const key of uploadedKeys) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        console.log('[INT] Cleaned up R2 object:', key);
      } catch (err) {
        console.warn('[INT] Cleanup failed for key:', key, err);
      }
    }
  });

  it('uploads 100KB buffer and returns correct key pattern', async () => {
    // 100KB random-ish buffer
    const buf = Buffer.alloc(102_400);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 256;

    const requestId = `int-test-${Date.now()}`;
    const t0 = Date.now();
    const key = await service.uploadBuffer(buf, 'image/png', requestId, 0);
    const elapsed = Date.now() - t0;

    uploadedKeys.push(key);

    // Key pattern: images/YYYY/MM/DD/<requestId>/0.png
    expect(key).toMatch(/^images\/\d{4}\/\d{2}\/\d{2}\/.+\/0\.png$/);
    expect(key).toContain(requestId);

    console.log('[INT] Uploaded key:', key, 'in', elapsed, 'ms');
  });

  it('generates presigned URL (TTL 5 min) and fetches object successfully', async () => {
    // Upload a small known buffer
    const content = Buffer.from('integration-test-content-r2-CONN-0052');
    const requestId = `int-presign-${Date.now()}`;
    const key = await service.uploadBuffer(content, 'image/png', requestId, 0);
    uploadedKeys.push(key);

    // Get presigned URL with 5 min TTL
    const presignedUrl = await service.getPresignedUrl(key, 300);

    expect(typeof presignedUrl).toBe('string');
    // R2 presigned URL format: https://<bucket>.<account_id>.r2.cloudflarestorage.com/<key>
    expect(presignedUrl).toContain(key);
    console.log('[INT] Presigned URL generated (truncated):', presignedUrl.slice(0, 80) + '...');

    // Fetch the presigned URL
    const response = await fetch(presignedUrl);
    expect(response.ok).toBe(true);

    const body = await response.arrayBuffer();
    const fetchedContent = Buffer.from(body);
    expect(fetchedContent.toString()).toBe(content.toString());

    const contentType = response.headers.get('content-type');
    console.log('[INT] Fetched content-type:', contentType, 'size:', fetchedContent.length);
    expect(fetchedContent.length).toBe(content.length);
  });

  it('getPublicUrl returns correct URL shape', () => {
    const key = 'images/2026/05/07/test-req/0.png';
    const url = service.getPublicUrl(key);

    expect(url).toContain(endpoint);
    expect(url).toContain(bucket);
    expect(url).toContain(key);
    console.log('[INT] Public URL:', url);
  });
});
