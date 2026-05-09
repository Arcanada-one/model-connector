import { describe, it, expect, beforeEach } from 'vitest';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { R2StorageService } from './r2.service';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

const s3Mock = mockClient(S3Client);

describe('R2StorageService', () => {
  let service: R2StorageService;

  beforeEach(() => {
    s3Mock.reset();
    service = new R2StorageService(
      'test-account',
      'test-key',
      'test-secret',
      'test-bucket',
      'https://test-account.r2.cloudflarestorage.com',
    );
  });

  describe('uploadBuffer', () => {
    it('uploads buffer and returns R2 key', async () => {
      s3Mock.on(PutObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      const buffer = Buffer.from('fake-image-data');
      const key = await service.uploadBuffer(buffer, 'image/png', 'req-123', 0);

      expect(key).toMatch(/^images\/\d{4}\/\d{2}\/\d{2}\/req-123\/0\.png$/);
    });

    it('uses webp extension for webp mime type', async () => {
      s3Mock.on(PutObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });

      const key = await service.uploadBuffer(Buffer.from('data'), 'image/webp', 'req-456', 1);
      expect(key).toMatch(/\.webp$/);
    });

    it('throws when PutObjectCommand fails', async () => {
      s3Mock.on(PutObjectCommand).rejects(new Error('S3 upload failed'));

      await expect(
        service.uploadBuffer(Buffer.from('data'), 'image/png', 'req-fail', 0),
      ).rejects.toThrow('S3 upload failed');
    });
  });

  describe('getPublicUrl', () => {
    it('returns correct public URL for key', () => {
      const url = service.getPublicUrl('images/2026/05/07/req-123/0.png');
      expect(url).toContain('images/2026/05/07/req-123/0.png');
    });
  });

  describe('getPresignedUrl', () => {
    it('returns presigned URL string', async () => {
      // getSignedUrl is mocked by aws-sdk-client-mock automatically
      const url = await service.getPresignedUrl('images/2026/05/07/req-123/0.png', 3600);
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    });
  });
});

// ─── Placeholder detection ────────────────────────────────────────────────────

describe('R2StorageService — placeholder credential detection', () => {
  it('throws ProviderNotProvisionedError on uploadBuffer when access_key_id is PLACEHOLDER', async () => {
    const service = new R2StorageService(
      'test-account',
      'PLACEHOLDER_CONN-0052',
      'PLACEHOLDER_CONN-0052',
      'test-bucket',
      'https://test.r2.cloudflarestorage.com',
    );

    await expect(
      service.uploadBuffer(Buffer.from('data'), 'image/png', 'req-123', 0),
    ).rejects.toThrow(ProviderNotProvisionedError);
  });

  it('throws ProviderNotProvisionedError on getPresignedUrl when access_key_id is PLACEHOLDER', async () => {
    const service = new R2StorageService(
      'test-account',
      'PLACEHOLDER_CONN-0052',
      'PLACEHOLDER_CONN-0052',
      'test-bucket',
      'https://test.r2.cloudflarestorage.com',
    );

    await expect(service.getPresignedUrl('images/2026/05/07/req/0.png', 3600)).rejects.toThrow(
      ProviderNotProvisionedError,
    );
  });
});
