import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

/**
 * A2-435 — the image inspector of this connector calls the real, native `sharp`, and no other test
 * does: every connector spec injects `inspectImage`. A bump of `sharp` (A2-432: 0.35.3 → 0.35.4)
 * was therefore invisible to the suite. These cases load the installed library with nothing mocked.
 *
 * The PNG is assembled here byte by byte rather than produced by sharp, so the check reads what an
 * independent writer writes instead of sharp agreeing with itself.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGB PNG of the given size, every pixel the same colour. */
function handMadePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('sharp (real native library)', () => {
  it('reads format and dimensions of a PNG it did not write', async () => {
    const metadata = await sharp(handMadePng(4, 3), { animated: false }).metadata();
    expect({ format: metadata.format, width: metadata.width, height: metadata.height }).toEqual({
      format: 'png',
      width: 4,
      height: 3,
    });
  });

  it('tells two sizes apart, so a constant answer cannot pass', async () => {
    const metadata = await sharp(handMadePng(7, 2)).metadata();
    expect([metadata.width, metadata.height]).toEqual([7, 2]);
  });

  it('refuses bytes that are not an image', async () => {
    await expect(sharp(Buffer.from('not an image')).metadata()).rejects.toThrow();
  });
});
