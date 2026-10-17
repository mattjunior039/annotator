export const PROOF_MAX_PIXELS = 4_000_000;
export const PROOF_MAX_FILE_BYTES = 8 * 1024 * 1024;
export interface MediaHeader { format: 'PNG' | 'JPEG' | 'WebP'; width: number; height: number }

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function checkSize(format: MediaHeader['format'], width: number, height: number): MediaHeader {
  if (width <= 0 || height <= 0 || width * height > PROOF_MAX_PIXELS) {
    throw new Error('Image exceeds the Phase 1 proof limit of 4 megapixels.');
  }
  return { format, width, height };
}
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunks(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks: string[] = [];
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length || length > PROOF_MAX_FILE_BYTES) throw new Error('Truncated PNG chunk.');
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('Invalid PNG chunk name.');
    if (view.getUint32(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))) throw new Error('Invalid PNG checksum.');
    chunks.push(type); offset = end;
    if (type === 'IEND') {
      if (length !== 0) throw new Error('Invalid PNG end marker.');
      ended = true; break;
    }
    if (chunks.length > 4096) throw new Error('PNG has too many chunks.');
  }
  if (!ended || offset !== bytes.length || chunks[0] !== 'IHDR' ||
      chunks.filter(c => c === 'IHDR').length !== 1 || !chunks.includes('IDAT')) {
    throw new Error('Invalid or incomplete PNG structure.');
  }
  return chunks;
}
export function inspectMedia(bytes: Uint8Array): MediaHeader {
  if (bytes.length > PROOF_MAX_FILE_BYTES) throw new Error('Image exceeds the Phase 1 proof limit of 8 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') {
    const chunks = pngChunks(bytes);
    if (view.getUint32(8) !== 13) throw new Error('Invalid PNG header.');
    if (chunks.includes('acTL')) throw new Error('Animated images are not supported.');
    if (chunks.includes('iCCP')) throw new Error('ICC-profiled images are not certified by this Phase 1 proof.');
    if (bytes[24] === 16) throw new Error('16-bit image fidelity is not certified by this Phase 1 proof.');
    return checkSize('PNG', view.getUint32(16), view.getUint32(20));
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2, width = 0, height = 0, scan = false, segments = 0;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG marker.');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9) break;
      if (marker === 0xd8 || marker === 0x00) throw new Error('Invalid JPEG structure.');
      if (offset + 2 > bytes.length) throw new Error('Truncated JPEG segment.');
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('Truncated JPEG segment.');
      if (marker === 0xe2 && ascii(bytes, offset + 2, 11) === 'ICC_PROFILE') {
        throw new Error('ICC-profiled images are not certified by this Phase 1 proof.');
      }
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (width !== 0) throw new Error('Only single-frame JPEG is supported.');
        const components = bytes[offset + 7];
        if (length < 8 || bytes[offset + 2] !== 8 || (components !== 1 && components !== 3) ||
            length !== 8 + 3 * components) {
          throw new Error('Only 8-bit non-CMYK JPEG is certified by this Phase 1 proof.');
        }
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
        checkSize('JPEG', width, height);
      }
      if (marker === 0xda) { scan = true; break; }
      offset += length;
      if (++segments > 4096) throw new Error('JPEG has too many segments.');
    }
    if (!scan || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Incomplete JPEG image.');
    return checkSize('JPEG', width, height);
  }
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('Invalid WebP container size.');
    let offset = 12, width = 0, height = 0, image = false, chunks = 0;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, 4), length = view.getUint32(offset + 4, true), p = offset + 8;
      if (p + length + (length % 2) > bytes.length) throw new Error('Truncated WebP chunk.');
      if (type === 'ANIM' || type === 'ANMF') throw new Error('Animated images are not supported.');
      if (type === 'ICCP') throw new Error('ICC-profiled images are not certified by this Phase 1 proof.');
      if (type === 'VP8X') {
        if (width !== 0 || image) throw new Error('Invalid duplicate WebP header.');
        if (length !== 10 || (bytes[p]! & 2) !== 0) throw new Error('Animated or invalid WebP.');
        width = 1 + bytes[p + 4]! + (bytes[p + 5]! << 8) + (bytes[p + 6]! << 16);
        height = 1 + bytes[p + 7]! + (bytes[p + 8]! << 8) + (bytes[p + 9]! << 16);
      } else if (type === 'VP8 ') {
        if (image) throw new Error('Animated or duplicate WebP frames are not supported.');
        if (length < 10 || ascii(bytes, p + 3, 3) !== '\x9d\x01\x2a') throw new Error('Invalid WebP frame.');
        image = true;
        const frame = checkSize('WebP', view.getUint16(p + 6, true) & 0x3fff, view.getUint16(p + 8, true) & 0x3fff);
        if (width !== 0 && (width !== frame.width || height !== frame.height)) throw new Error('Invalid WebP dimensions.');
        width = frame.width; height = frame.height;
      } else if (type === 'VP8L') {
        if (image) throw new Error('Animated or duplicate WebP frames are not supported.');
        if (length < 5 || bytes[p] !== 0x2f) throw new Error('Invalid lossless WebP frame.');
        image = true;
        const bits = view.getUint32(p + 1, true);
        const frame = checkSize('WebP', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        if (width !== 0 && (width !== frame.width || height !== frame.height)) throw new Error('Invalid WebP dimensions.');
        width = frame.width; height = frame.height;
      }
      offset = p + length + length % 2;
      if (++chunks > 4096) throw new Error('WebP has too many chunks.');
    }
    if (offset !== bytes.length || !image) throw new Error('Incomplete WebP image.');
    return checkSize('WebP', width, height);
  }
  throw new Error('Only JPEG, PNG, and WebP still images are supported by this proof.');
}

export function verifySanitizedPng(bytes: Uint8Array): MediaHeader {
  const header = inspectMedia(bytes);
  const allowed = new Set(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM']);
  if (header.format !== 'PNG' || pngChunks(bytes).some(c => !allowed.has(c))) {
    throw new Error('Sanitized output contains unapproved chunks.');
  }
  return header;
}

export async function sanitizeImage(file: File): Promise<{
  png: ArrayBuffer; width: number; height: number; inputBytes: number; outputBytes: number;
  maxPixelDifference: number; milliseconds: number; format: MediaHeader['format'];
}> {
  const start = performance.now();
  if (file.size > PROOF_MAX_FILE_BYTES) throw new Error('Image exceeds the Phase 1 proof limit of 8 MiB.');
  const header = inspectMedia(new Uint8Array(await file.arrayBuffer()));
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', colorSpaceConversion: 'default' });
  let sanitized: ImageBitmap | undefined;
  try {
    checkSize(header.format, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!context) throw new Error('An sRGB 2D canvas is required for the media proof.');
    context.drawImage(bitmap, 0, 0);
    const original = context.getImageData(0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (blob.size > PROOF_MAX_FILE_BYTES) throw new Error('Lossless PNG exceeds the 8 MiB proof storage limit.');
    const png = await blob.arrayBuffer(), output = verifySanitizedPng(new Uint8Array(png));
    sanitized = await createImageBitmap(blob);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sanitized, 0, 0);
    const roundTrip = context.getImageData(0, 0, canvas.width, canvas.height);
    let maxPixelDifference = 0;
    for (let i = 0; i < original.data.length; i++) {
      // RGB beneath fully transparent pixels has no rendered meaning.
      if (i % 4 !== 3 && original.data[i - i % 4 + 3] === 0) continue;
      maxPixelDifference = Math.max(maxPixelDifference, Math.abs(original.data[i]! - roundTrip.data[i]!));
    }
    if (maxPixelDifference > 0 || output.width !== canvas.width || output.height !== canvas.height) {
      throw new Error('Lossless rendered-pixel verification failed; no image was persisted.');
    }
    return {
      png, width: canvas.width, height: canvas.height, inputBytes: file.size, outputBytes: png.byteLength,
      maxPixelDifference, milliseconds: performance.now() - start, format: header.format,
    };
  } finally { bitmap.close(); sanitized?.close(); }
}
