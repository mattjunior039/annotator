import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = fileURLToPath(new URL('../tests/fixtures/generated/', import.meta.url));
await mkdir(directory, { recursive: true });
const width = 30, height = 20, rgba = Buffer.alloc(width * height * 4);
const colors = [[240, 20, 10], [10, 220, 30], [20, 40, 240], [240, 220, 10], [230, 20, 220], [10, 220, 230]];
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const color = colors[Math.floor(y / 10) * 3 + Math.floor(x / 10)];
  const index = (y * width + x) * 4;
  rgba.set([...color, 255], index);
}
const image = () => sharp(rgba, { raw: { width, height, channels: 4 } });
const exif = orientation => ({
  IFD0: { Orientation: String(orientation), Artist: 'CANARY_ARTIST', Make: 'CANARY_CAMERA', DateTime: '2020:01:02 03:04:05' },
  IFD2: { BodySerialNumber: 'CANARY_SERIAL' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 46/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '122/1 25/1 0/1' },
});
function setExifOrientation(jpeg, orientation) {
  const start = jpeg.indexOf(Buffer.from('Exif\0\0')) + 6;
  if (start < 6) throw new Error('Fixture has no EXIF block.');
  const little = jpeg.toString('ascii', start, start + 2) === 'II';
  const read16 = offset => little ? jpeg.readUInt16LE(offset) : jpeg.readUInt16BE(offset);
  const read32 = offset => little ? jpeg.readUInt32LE(offset) : jpeg.readUInt32BE(offset);
  const ifd = start + read32(start + 4);
  for (let index = 0; index < read16(ifd); index++) {
    const tag = ifd + 2 + index * 12;
    if (read16(tag) === 0x112) {
      if (little) jpeg.writeUInt16LE(orientation, tag + 8);
      else jpeg.writeUInt16BE(orientation, tag + 8);
      return jpeg;
    }
  }
  throw new Error('Fixture has no orientation tag.');
}
for (let orientation = 1; orientation <= 8; orientation++) {
  const jpeg = setExifOrientation(await image().withExif(exif(orientation))
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer(), orientation);
  const metadata = await sharp(jpeg).metadata();
  if (metadata.orientation !== orientation || !metadata.exif?.includes(Buffer.from('CANARY_CAMERA')) ||
      !metadata.exif.includes(Buffer.from('CANARY_SERIAL'))) throw new Error('Fixture orientation/metadata verification failed.');
  await writeFile(`${directory}/orientation-${orientation}.jpg`, jpeg);
}
await image().withExif(exif(1)).webp({ lossless: true }).toFile(`${directory}/metadata.webp`);
await image().withExif(exif(1)).png().toFile(`${directory}/metadata.png`);
await image().resize(2048, 1536, { fit: 'fill', kernel: 'nearest' }).png().toFile(`${directory}/reference.png`);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}
const plainPng = await image().png().toBuffer();
const gamma = Buffer.alloc(4); gamma.writeUInt32BE(45455);
await writeFile(`${directory}/gamma-text.png`, Buffer.concat([
  plainPng.subarray(0, 33), pngChunk('gAMA', gamma),
  pngChunk('tEXt', Buffer.from('Comment\0CANARY_PNG_TEXT')), plainPng.subarray(33),
]));
const alpha = Buffer.from(rgba);
for (let i = 3; i < alpha.length; i += 4) alpha[i] = Math.floor(i / 4) % 256;
await sharp(alpha, { raw: { width, height, channels: 4 } }).png().toFile(`${directory}/alpha.png`);
await image().withIccProfile('p3').png().toFile(`${directory}/icc.png`);
await image().toColourspace('rgb16').png().toFile(`${directory}/sixteen-bit.png`);
const secondFrame = Buffer.from(rgba);
for (let i = 0; i < secondFrame.length; i += 4) secondFrame[i] = 255 - secondFrame[i];
await sharp(Buffer.concat([rgba, secondFrame]), {
  raw: { width, height: height * 2, channels: 4, pageHeight: height },
}).webp({ loop: 0, delay: [100, 100] }).toFile(`${directory}/animated.webp`);
await writeFile(`${directory}/invalid.png`, Buffer.from('not an image'));
await writeFile(`${directory}/manifest.json`, JSON.stringify({
  version: 1, generator: 'scripts/fixtures.mjs', source: { width, height },
  note: 'Synthetic color blocks only. No third-party images.',
  expectedOrientedDimensions: Array.from({ length: 8 }, (_, i) => i < 4 ? [30, 20] : [20, 30]),
}, null, 2));
console.log(`Generated synthetic media fixtures in ${directory}`);
