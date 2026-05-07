import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const DEFAULT_PRESIGNED_TTL_SECONDS = 86400; // 24 hours
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Cloudflare R2 storage service.
 * Upload images, generate presigned download URLs.
 * Object path: images/${YYYY}/${MM}/${DD}/${requestId}/${idx}.${ext}
 */
export class R2StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicEndpoint: string;

  constructor(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
    bucket: string,
    endpoint: string,
  ) {
    this.bucket = bucket;
    this.publicEndpoint = endpoint;
    this.client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  /**
   * Upload a Buffer to R2.
   * Returns the R2 object key.
   */
  async uploadBuffer(
    data: Buffer,
    mimeType: string,
    requestId: string,
    index: number,
  ): Promise<string> {
    const ext = MIME_TO_EXT[mimeType] ?? 'png';
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const key = `images/${yyyy}/${mm}/${dd}/${requestId}/${index}.${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: mimeType,
      }),
    );

    return key;
  }

  /**
   * Returns a direct public URL (requires bucket to be public).
   * Used when presigned URL is not required.
   */
  getPublicUrl(key: string): string {
    return `${this.publicEndpoint}/${this.bucket}/${key}`;
  }

  /**
   * Returns a time-limited presigned URL for downloading the object.
   * @param key    R2 object key
   * @param ttlSeconds  URL validity in seconds (default 24h, max 7d)
   */
  async getPresignedUrl(key: string, ttlSeconds = DEFAULT_PRESIGNED_TTL_SECONDS): Promise<string> {
    const clampedTtl = Math.min(Math.max(ttlSeconds, 3600), 604800);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: clampedTtl,
    });
  }
}
