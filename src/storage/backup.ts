import { z } from 'zod';
import { createVaultKey, hex, MAX_OBJECT_BYTES, openObject, sealObject, unlockVaultKey, wrappedKeySchema } from '../crypto/vault';
import { documentSchema } from '../domain/model';
import type { AnnotationDocument } from '../domain/model';
import { verifySanitizedPng } from '../datasets/media';
import { datasetSchemaSchema } from '../domain/dataset-schema';
import type { DatasetSchema } from '../domain/dataset-schema';
import { checkMaskPayloads, checkTile, maskIds, TILE_BYTES } from '../domain/masks';
import type { MaskTile } from '../domain/masks';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const maxEnvelopeBytes = MAX_OBJECT_BYTES + 16_384;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const objectSchema = z.strictObject({
  bytes: z.number().int().min(1).max(maxEnvelopeBytes), sha256: digestSchema,
});
const entrySchema = z.strictObject({
  id: z.uuid(), mediaId: z.uuid(), record: objectSchema, media: objectSchema,
  tiles: z.array(z.strictObject({ id: z.uuid(), object: objectSchema })).max(128).optional(),
});
const manifestSchema = z.strictObject({
  version: z.literal(1), backupId: z.uuid(), entries: z.array(entrySchema).max(10_000),
  datasetSchema: datasetSchemaSchema.optional(),
}).superRefine((manifest, context) => {
  if (new Set(manifest.entries.map(item => item.id)).size !== manifest.entries.length ||
      new Set(manifest.entries.map(item => item.mediaId)).size !== manifest.entries.length) {
    context.addIssue({ code: 'custom', message: 'Backup contains duplicate object IDs.' });
  }
});
const bootstrapSchema = z.strictObject({
  format: z.literal('annotator-encrypted-backup'), version: z.literal(1),
  key: wrappedKeySchema, manifest: objectSchema,
});
export const backupRecordSchema = z.strictObject({
  document: documentSchema, sourcePath: z.string().min(1).max(1024), split: z.enum(['train', 'val', 'test']),
});
export type BackupRecord = z.infer<typeof backupRecordSchema>;
type ManifestEntry = z.infer<typeof entrySchema>;

export interface ArchiveDirectory {
  getFileHandle(name: string, options?: { create: boolean }): Promise<{
    getFile(): Promise<Blob>;
    createWritable(): Promise<{
      write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
async function readFile(directory: ArchiveDirectory, name: string, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const file = await (await directory.getFileHandle(name)).getFile();
  if (file.size > limit) throw new Error('Backup file exceeds the supported size limit.');
  return new Uint8Array(await file.arrayBuffer());
}
async function writeVerified(directory: ArchiveDirectory, name: string, bytes: Uint8Array<ArrayBuffer>) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try { await writer.write(bytes); await writer.close(); }
  catch (failure) {
    try { await writer.abort(); }
    catch { throw new Error('Backup write and cleanup failed. The backup folder is incomplete.'); }
    throw failure;
  }
  const stored = await readFile(directory, name, bytes.byteLength);
  const sha256 = await digest(bytes);
  if (stored.byteLength !== bytes.byteLength || await digest(stored) !== sha256) {
    throw new Error('Backup write verification failed. The backup folder is incomplete.');
  }
  return { bytes: bytes.byteLength, sha256 };
}
async function verifiedRead(directory: ArchiveDirectory, name: string, descriptor: z.infer<typeof objectSchema>) {
  const bytes = await readFile(directory, name, descriptor.bytes);
  if (bytes.byteLength !== descriptor.bytes || await digest(bytes) !== descriptor.sha256) {
    throw new Error('Backup object is missing, damaged, or has been replaced.');
  }
  return bytes;
}
function verifyRecord(record: BackupRecord, media: Uint8Array<ArrayBuffer>) {
  const dimensions = verifySanitizedPng(media);
  if (dimensions.width !== record.document.image.canonical.width ||
      dimensions.height !== record.document.image.canonical.height) {
    throw new Error('Backup image dimensions do not match its annotation document.');
  }
  maskIds(record.document);
}

export class BackupWriter {
  private readonly entries: ManifestEntry[] = [];
  private readonly ids = new Set<string>();
  private completed = false;
  get id(): string { return this.key.workspaceId; }
  private constructor(
    private readonly directory: ArchiveDirectory,
    private readonly root: CryptoKey,
    private readonly key: z.infer<typeof wrappedKeySchema>,
    private readonly schema?: DatasetSchema,
  ) {}

  static async create(directory: ArchiveDirectory, passphrase: string, schema?: DatasetSchema): Promise<BackupWriter> {
    let existing = false;
    try { await directory.getFileHandle('backup.json'); existing = true; }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
    if (existing) throw new Error('Backup destination already contains a completion header. Choose a new folder.');
    const { root, wrapped } = await createVaultKey(passphrase, crypto.randomUUID());
    return new BackupWriter(directory, root, wrapped, schema ? datasetSchemaSchema.parse(schema) : undefined);
  }
  async append(input: BackupRecord, media: Uint8Array<ArrayBuffer>, tiles: MaskTile[] = []): Promise<void> {
    if (this.completed) throw new Error('Backup is already complete; its files cannot be changed.');
    const record = backupRecordSchema.parse(input);
    if (this.entries.length >= 10_000) throw new Error('Backup image limit exceeded.');
    if (this.ids.has(record.document.image.id)) throw new Error('Backup image was already written.');
    verifyRecord(record, media);
    const required = new Set(maskIds(record.document));
    if (tiles.length !== required.size || new Set(tiles.map(tile => tile.id)).size !== tiles.length ||
        tiles.some(tile => !required.has(tile.id))) throw new Error('Backup mask references require their exact tile data.');
    for (const tile of tiles) checkTile(new Uint8Array(tile.pixels));
    checkMaskPayloads(record.document, tiles);
    const id = record.document.image.id, mediaId = record.document.image.mediaId;
    const recordBytes = await sealObject(this.root, this.key.workspaceId, id,
      encoder.encode(JSON.stringify(record)), 'backup-record');
    const mediaBytes = await sealObject(this.root, this.key.workspaceId, mediaId, media, 'backup-media');
    const recordInfo = await writeVerified(this.directory, `${id}.record.enc`, recordBytes);
    const mediaInfo = await writeVerified(this.directory, `${mediaId}.media.enc`, mediaBytes);
    const tileInfo = [];
    for (const tile of tiles) {
      const bytes = await sealObject(this.root, this.key.workspaceId, tile.id, new Uint8Array(tile.pixels), 'backup-mask');
      tileInfo.push({ id: tile.id, object: await writeVerified(this.directory, `${tile.id}.mask.enc`, bytes) });
    }
    this.entries.push({ id, mediaId, record: recordInfo, media: mediaInfo, ...(tileInfo.length ? { tiles: tileInfo } : {}) });
    this.ids.add(id);
  }
  async finish(): Promise<void> {
    if (this.completed) throw new Error('Backup is already complete; its files cannot be changed.');
    const manifest = manifestSchema.parse({
      version: 1, backupId: this.key.workspaceId, entries: this.entries,
      ...(this.schema ? { datasetSchema: this.schema } : {}),
    });
    const bytes = await sealObject(this.root, this.key.workspaceId, this.key.workspaceId,
      encoder.encode(JSON.stringify(manifest)), 'backup-manifest');
    const descriptor = await writeVerified(this.directory, 'manifest.enc', bytes);
    const bootstrap = bootstrapSchema.parse({
      format: 'annotator-encrypted-backup', version: 1, key: this.key, manifest: descriptor,
    });
    // The completion header is written last; no header means no complete backup.
    await writeVerified(this.directory, 'backup.json', encoder.encode(JSON.stringify(bootstrap)));
    this.completed = true;
  }
}

export class BackupReader {
  private constructor(
    private readonly directory: ArchiveDirectory,
    private readonly root: CryptoKey,
    private readonly manifest: z.infer<typeof manifestSchema>,
  ) {}
  get count(): number { return this.manifest.entries.length; }
  get id(): string { return this.manifest.backupId; }
  get schema(): DatasetSchema | undefined { return this.manifest.datasetSchema; }
  static async open(directory: ArchiveDirectory, passphrase: string): Promise<BackupReader> {
    const bootstrap = bootstrapSchema.parse(JSON.parse(decoder.decode(await readFile(directory, 'backup.json', 4096))));
    const root = await unlockVaultKey(passphrase, bootstrap.key);
    const encrypted = await verifiedRead(directory, 'manifest.enc', bootstrap.manifest);
    const manifest = manifestSchema.parse(JSON.parse(decoder.decode(await openObject(
      root, bootstrap.key.workspaceId, bootstrap.key.workspaceId, encrypted, 'backup-manifest',
    ))));
    if (manifest.backupId !== bootstrap.key.workspaceId) throw new Error('Backup manifest belongs to a different archive.');
    return new BackupReader(directory, root, manifest);
  }
  async read(index: number): Promise<{ record: BackupRecord; media: Uint8Array<ArrayBuffer>; tiles: MaskTile[] }> {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error('Backup image index is invalid.');
    const entry = this.manifest.entries[index]!;
    const recordBytes = await verifiedRead(this.directory, `${entry.id}.record.enc`, entry.record);
    const record = backupRecordSchema.parse(JSON.parse(decoder.decode(await openObject(
      this.root, this.manifest.backupId, entry.id, recordBytes, 'backup-record',
    ))));
    if (record.document.image.id !== entry.id || record.document.image.mediaId !== entry.mediaId) {
      throw new Error('Backup image references do not match the authenticated manifest.');
    }
    const mediaBytes = await verifiedRead(this.directory, `${entry.mediaId}.media.enc`, entry.media);
    const media = await openObject(this.root, this.manifest.backupId, entry.mediaId, mediaBytes, 'backup-media');
    verifyRecord(record, media);
    const required = new Set(maskIds(record.document)), descriptors = entry.tiles ?? [];
    if (descriptors.length !== required.size || new Set(descriptors.map(tile => tile.id)).size !== descriptors.length ||
        descriptors.some(tile => !required.has(tile.id))) throw new Error('Backup mask references do not match its authenticated manifest.');
    const tiles: MaskTile[] = [];
    for (const tile of descriptors) {
      const bytes = await verifiedRead(this.directory, `${tile.id}.mask.enc`, tile.object);
      const pixels = await openObject(this.root, this.manifest.backupId, tile.id, bytes, 'backup-mask');
      if (pixels.length !== TILE_BYTES) throw new Error('Backup mask tile size is invalid.');
      checkTile(pixels);
      tiles.push({ id: tile.id, pixels: pixels.buffer });
    }
    checkMaskPayloads(record.document, tiles);
    return { record, media, tiles };
  }
}

export function restoredDocument(input: AnnotationDocument, workspaceId: string): AnnotationDocument {
  return documentSchema.parse({
    ...input, image: { ...input.image, datasetId: workspaceId, mediaId: crypto.randomUUID() },
  });
}
