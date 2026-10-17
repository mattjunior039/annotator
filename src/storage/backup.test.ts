import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { documentSchema } from '../domain/model';
import { hex } from '../crypto/vault';
import { BackupReader, BackupWriter, restoredDocument } from './backup';
import type { ArchiveDirectory, BackupRecord } from './backup';
import { emptyDatasetSchema, mergeDatasetSchema } from '../domain/dataset-schema';

class MemoryDirectory implements ArchiveDirectory {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  truncateWrites = false;
  async getFileHandle(name: string, options?: { create: boolean }) {
    if (!options?.create && !this.files.has(name)) throw new DOMException('Missing backup file.', 'NotFoundError');
    return {
      getFile: async () => new Blob([this.files.get(name)!]),
      createWritable: async () => ({
        write: async (data: Uint8Array<ArrayBuffer>) => {
          this.files.set(name, this.truncateWrites ? data.slice(0, -1) : data.slice());
        },
        close: async () => {}, abort: async () => {},
      }),
    };
  }
  copy() {
    const directory = new MemoryDirectory();
    for (const [name, bytes] of this.files) directory.files.set(name, bytes.slice());
    return directory;
  }
}

const passphrase = 'independent backup test passphrase';
let media: Uint8Array<ArrayBuffer>, record: BackupRecord, archive: MemoryDirectory;
beforeAll(async () => {
  const png = await sharp({
    create: { width: 30, height: 20, channels: 4, background: { r: 12, g: 24, b: 36, alpha: 1 } },
  }).png().toBuffer();
  const chunks = [png.subarray(0, 8)];
  for (let offset = 8; offset < png.length;) {
    const end = offset + 12 + png.readUInt32BE(offset);
    if (['IHDR', 'IDAT', 'IEND'].includes(png.toString('ascii', offset + 4, offset + 8))) chunks.push(png.subarray(offset, end));
    offset = end;
  }
  media = new Uint8Array(Buffer.concat(chunks));
  const classId = crypto.randomUUID(), skeletonId = crypto.randomUUID();
  record = {
    sourcePath: 'patient/private.png', split: 'val',
    document: documentSchema.parse({
      version: 1, revision: 19, review: 'reviewed',
      image: { version: 1, id: crypto.randomUUID(), datasetId: crypto.randomUUID(),
        name: 'private.png', source: { width: 30, height: 20 }, canonical: { width: 30, height: 20 },
        orientation: 1, mediaId: crypto.randomUUID() },
      classes: [{ id: classId, name: 'sensitive-class', color: '#39764d', exclusiveGroup: null }],
      skeletons: [{ id: skeletonId, name: 'skeleton', points: ['tip'], edges: [] }],
      annotations: [
        { id: crypto.randomUUID(), classId, kind: 'box', x: 2, y: 3, width: 5, height: 6, attributes: { checked: true } },
        { id: crypto.randomUUID(), classId, kind: 'label', attributes: { detail: 'secret-note' } },
        { id: crypto.randomUUID(), classId, kind: 'polygon', attributes: {},
          points: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 5, y: 10 }] },
        { id: crypto.randomUUID(), classId, kind: 'keypoints', skeletonId,
          points: [{ x: 1, y: 2, visibility: 'occluded' }], attributes: {} },
      ],
    }),
  };
  archive = new MemoryDirectory();
  const writer = await BackupWriter.create(archive, passphrase);
  await writer.append(record, media);
  expect(archive.files.has('backup.json')).toBe(false);
  await writer.finish();
});

describe('encrypted native dataset backup', () => {
  it('retains a dataset-wide schema even in an empty backup and keeps it encrypted', async () => {
    const schema = mergeDatasetSchema(emptyDatasetSchema(), record.document);
    const directory = new MemoryDirectory();
    const writer = await BackupWriter.create(directory, passphrase, schema);
    await writer.finish();
    const reader = await BackupReader.open(directory, passphrase);
    expect(reader.count).toBe(0);
    expect(reader.schema).toEqual(schema);
    for (const bytes of directory.files.values()) expect(new TextDecoder().decode(bytes)).not.toContain('sensitive-class');
    const populated = new MemoryDirectory();
    const populatedWriter = await BackupWriter.create(populated, passphrase, schema);
    await populatedWriter.append(record, media);
    await populatedWriter.finish();
    const populatedReader = await BackupReader.open(populated, passphrase);
    expect(populatedReader.schema).toEqual(schema);
    expect((await populatedReader.read(0)).record).toEqual(record);
    const legacy = await BackupReader.open(archive, passphrase);
    expect(legacy.schema).toBeUndefined();
  });
  it('round trips every supported annotation kind and metadata without storing sensitive plaintext', async () => {
    const reader = await BackupReader.open(archive, passphrase);
    expect(reader.count).toBe(1);
    const result = await reader.read(0);
    expect(result.record).toEqual(record);
    expect(result.media).toEqual(media);
    for (const [name, bytes] of archive.files) {
      expect(name).not.toContain('private');
      const text = new TextDecoder().decode(bytes);
      for (const canary of ['patient/', 'private.png', 'sensitive-class', 'secret-note']) expect(text).not.toContain(canary);
    }
    await expect(reader.read(1)).rejects.toThrow('index');
    await expect(reader.read(-1)).rejects.toThrow('index');
  });
  it('rejects wrong passphrases and archives without the final completion header', async () => {
    await expect(BackupReader.open(archive, 'wrong backup passphrase')).rejects.toThrow('Unable to unlock');
    const incomplete = archive.copy();
    incomplete.files.delete('backup.json');
    await expect(BackupReader.open(incomplete, passphrase)).rejects.toThrow('Missing');
  });
  it('rejects invalid/oversized headers, unsupported versions, and hostile KDF parameters before opening', async () => {
    const bootstrap = JSON.parse(new TextDecoder().decode(archive.files.get('backup.json')!));
    for (const value of [
      { ...bootstrap, version: 2 },
      { ...bootstrap, key: { ...bootstrap.key, iterations: 2_000_001 } },
      { ...bootstrap, unexpected: true },
    ]) {
      const invalid = archive.copy();
      invalid.files.set('backup.json', new TextEncoder().encode(JSON.stringify(value)));
      await expect(BackupReader.open(invalid, passphrase)).rejects.toThrow();
    }
    const oversized = archive.copy();
    oversized.files.set('backup.json', new Uint8Array(4097));
    await expect(BackupReader.open(oversized, passphrase)).rejects.toThrow('size limit');
  });
  it('authenticates the manifest even if an attacker updates its public ciphertext digest', async () => {
    const corrupt = archive.copy();
    const manifest = corrupt.files.get('manifest.enc')!;
    manifest[manifest.length - 1]! ^= 1;
    const bootstrap = JSON.parse(new TextDecoder().decode(corrupt.files.get('backup.json')!));
    bootstrap.manifest.sha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', manifest)));
    corrupt.files.set('backup.json', new TextEncoder().encode(JSON.stringify(bootstrap)));
    await expect(BackupReader.open(corrupt, passphrase)).rejects.toThrow('authentication');
  });
  it.each(['manifest.enc', 'record.enc', 'media.enc'])('rejects corrupted or truncated %s', async suffix => {
    const corrupt = archive.copy();
    const name = [...corrupt.files.keys()].find(name => name.endsWith(suffix))!;
    const original = corrupt.files.get(name)!;
    for (const bytes of [original.slice(0, -1), original.map((byte, i) => i === original.length - 1 ? byte ^ 1 : byte)]) {
      corrupt.files.set(name, bytes);
      await expect((async () => {
        const reader = await BackupReader.open(corrupt, passphrase);
        await reader.read(0);
      })()).rejects.toThrow();
    }
  });
  it('rejects ciphertext substitution across records and archives', async () => {
    const corrupt = archive.copy();
    const recordName = `${record.document.image.id}.record.enc`, mediaName = `${record.document.image.mediaId}.media.enc`;
    corrupt.files.set(recordName, corrupt.files.get(mediaName)!);
    const reader = await BackupReader.open(corrupt, passphrase);
    await expect(reader.read(0)).rejects.toThrow();
    const other = new MemoryDirectory();
    const writer = await BackupWriter.create(other, passphrase);
    await writer.append(record, media); await writer.finish();
    corrupt.files.set(recordName, other.files.get(recordName)!);
    await expect(reader.read(0)).rejects.toThrow();
  });
  it('verifies writes, rejects duplicate records, and never completes after an incomplete write', async () => {
    const incomplete = new MemoryDirectory(), writer = await BackupWriter.create(incomplete, passphrase);
    incomplete.truncateWrites = true;
    await expect(writer.append(record, media)).rejects.toThrow('verification');
    expect(incomplete.files.has('backup.json')).toBe(false);
    incomplete.truncateWrites = false;
    await writer.append(record, media);
    await expect(writer.append(record, media)).rejects.toThrow('already written');
  });
  it('rejects media/document mismatches and mask references without tile payloads', async () => {
    const directory = new MemoryDirectory(), writer = await BackupWriter.create(directory, passphrase);
    const wrong = structuredClone(record);
    wrong.document.image.source.width = wrong.document.image.canonical.width = 31;
    await expect(writer.append(wrong, media)).rejects.toThrow('dimensions');
    const mask = structuredClone(record);
    mask.document.annotations = [{
      id: crypto.randomUUID(), classId: mask.document.classes[0]!.id, attributes: {},
      kind: 'mask', width: 30, height: 20, tileSize: 256, tiles: [],
    }];
    await expect(writer.append(mask, media)).rejects.toThrow('mask references');
    expect(directory.files.size).toBe(0);
  });
  it('preserves document identities and revision on restore but rebinds media and workspace', () => {
    const workspaceId = crypto.randomUUID();
    const restored = restoredDocument(record.document, workspaceId);
    expect(restored).toEqual({
      ...record.document, image: { ...record.document.image, datasetId: workspaceId, mediaId: restored.image.mediaId },
    });
    expect(restored.image.mediaId).not.toBe(record.document.image.mediaId);
    expect(record.document.image.datasetId).not.toBe(workspaceId);
  });
  it('round trips an empty archive with an authenticated zero count', async () => {
    const directory = new MemoryDirectory(), writer = await BackupWriter.create(directory, passphrase);
    await writer.finish();
    const reader = await BackupReader.open(directory, passphrase);
    expect(reader.count).toBe(0);
    await expect(writer.append(record, media)).rejects.toThrow('already complete');
    await expect(writer.finish()).rejects.toThrow('already complete');
    await expect(BackupWriter.create(directory, passphrase)).rejects.toThrow('completion header');
  });
});
