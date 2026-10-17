import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { crc32, inspectMedia, pngChunks, verifySanitizedPng } from './media';

function chunk(type: string, content: Buffer): Buffer {
  const bytes = Buffer.alloc(content.length + 12);
  bytes.writeUInt32BE(content.length); bytes.write(type, 4); content.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png(options: { width?: number; depth?: number; extra?: string } = {}): Uint8Array<ArrayBuffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.width ?? 1); header.writeUInt32BE(1, 4);
  header[8] = options.depth ?? 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(options.extra ? [chunk(options.extra, Buffer.from('SENSITIVE_CANARY'))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]));
}
describe('bounded media structural validation', () => {
  it('checks PNG CRCs with a known vector and validates output allowlists', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(verifySanitizedPng(png())).toEqual({ format: 'PNG', width: 1, height: 1 });
    expect(pngChunks(png({ extra: 'tEXt' }))).toContain('tEXt');
    expect(() => verifySanitizedPng(png({ extra: 'tEXt' }))).toThrow('unapproved');
    const damaged = png(); damaged[damaged.length - 1]! ^= 1;
    expect(() => inspectMedia(damaged)).toThrow('checksum');
    expect(() => inspectMedia(png().slice(0, -1))).toThrow();
  });
  it('rejects animation, unverified color/depth, decoded size bombs and unknown formats', () => {
    expect(() => inspectMedia(png({ extra: 'acTL' }))).toThrow('Animated');
    expect(() => inspectMedia(png({ extra: 'iCCP' }))).toThrow('ICC-profiled');
    expect(() => inspectMedia(png({ depth: 16 }))).toThrow('16-bit');
    expect(() => inspectMedia(png({ width: 4_000_001 }))).toThrow('4 megapixels');
    expect(() => inspectMedia(new Uint8Array(8 * 1024 * 1024 + 1))).toThrow('8 MiB');
    expect(() => inspectMedia(new TextEncoder().encode('<svg onload="alert(1)"/>'))).toThrow('Only JPEG');
  });
  it('rejects malformed JPEG and WebP before decoding', () => {
    expect(() => inspectMedia(Uint8Array.from([255, 216, 255, 225, 255, 255]))).toThrow('Truncated JPEG');
    const bytes = Buffer.alloc(20); bytes.write('RIFF'); bytes.writeUInt32LE(5000, 4); bytes.write('WEBP', 8);
    expect(() => inspectMedia(bytes)).toThrow('WebP container');
  });
});
