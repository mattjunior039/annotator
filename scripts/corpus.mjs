import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';
import sharp from 'sharp';

const directory = fileURLToPath(new URL('../benchmarks/generated/reference-corpus/', import.meta.url));
const writeImages = process.argv.includes('--write-images');
if (process.argv.slice(2).some(arg => arg !== '--write-images')) throw new Error('Usage: npm run benchmark:corpus -- [--write-images]');
await mkdir(directory, { recursive: true });
const entries = [];
let totalBytes = 0;
for (let index = 0; index < 10_000; index++) {
  const entry = { index, name: `synthetic-${String(index).padStart(5, '0')}.png`, width: 2048, height: 1536, seed: index + 1 };
  if (writeImages) {
    const pixels = Buffer.alloc(entry.width * entry.height * 3);
    for (let y = 0; y < entry.height; y++) for (let x = 0; x < entry.width; x++) {
      const p = (y * entry.width + x) * 3;
      pixels[p] = (Math.floor(x / 64) * 17 + entry.seed) % 256;
      pixels[p + 1] = (Math.floor(y / 64) * 23 + entry.seed * 7) % 256;
      pixels[p + 2] = (Math.floor((x + y) / 128) * 31 + entry.seed * 11) % 256;
    }
    const png = await sharp(pixels, { raw: { width: entry.width, height: entry.height, channels: 3 } })
      .png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
    entry.bytes = png.length;
    entry.sha256 = createHash('sha256').update(png).digest('hex');
    await writeFile(`${directory}/${entry.name}`, png, { flag: 'wx' });
    totalBytes += png.length;
  }
  entries.push(entry);
}
const manifest = {
  version: 1, generator: 'synthetic-bands-v1', count: entries.length, encodedImagesGenerated: writeImages,
  totalEncodedBytes: writeImages ? totalBytes : null,
  profile: { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramBytes: os.totalmem(), node: process.version, sharp: sharp.versions },
  entries,
};
await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory, manifestBytes: (await stat(`${directory}/manifest.json`)).size, count: entries.length, totalEncodedBytes: manifest.totalEncodedBytes, encodedImagesGenerated: writeImages }));
