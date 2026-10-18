import { z } from 'zod';
import { MAX_OBJECT_BYTES, recoverySecretSchema } from '../crypto/vault';
import { documentSchema } from '../domain/model';
import { classRemapsSchema, datasetSchemaSchema } from '../domain/dataset-schema';
import { maskTileSchema } from '../domain/masks';
import { invitationSchema, SHARE_BYTES } from '../sharing/model';

const bufferSchema = z.instanceof(ArrayBuffer).refine(b => b.byteLength <= MAX_OBJECT_BYTES, 'Proof object exceeds 8 MiB.');
const workspaceBufferSchema = z.instanceof(ArrayBuffer).refine(b => b.byteLength <= MAX_OBJECT_BYTES, 'Image exceeds the current 8 MiB workspace limit.');
const directorySchema = z.custom<FileSystemDirectoryHandle>(value =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'directory' &&
  'getFileHandle' in value && typeof value.getFileHandle === 'function', 'A local directory handle is required.');
export const workspaceIdSchema = z.union([z.literal('legacy'), z.uuid()]);
export const workspaceDescriptorSchema = z.strictObject({
  id: workspaceIdSchema, name: z.string().trim().min(1).max(100),
  passwordProtected: z.boolean(), createdAt: z.string().datetime(),
  deleting: z.boolean().optional(),
});
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;
export const workspaceCatalogSchema = z.array(workspaceDescriptorSchema).max(100);
export const storageRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('catalog-list') }),
  z.strictObject({ type: z.literal('catalog-create'), name: z.string().trim().min(1).max(100),
    passwordProtected: z.boolean(), passphrase: z.string().max(1024) }),
  z.strictObject({ type: z.literal('catalog-delete'), workspaceId: workspaceIdSchema, confirmation: z.string().max(100) }),
  z.strictObject({ type: z.literal('workspace-open'), workspaceId: workspaceIdSchema }),
  z.strictObject({ type: z.literal('schema-open') }),
  z.strictObject({ type: z.literal('schema-step'), index: z.number().int().nonnegative().max(10_000) }),
  z.strictObject({ type: z.literal('schema-finish') }),
  z.strictObject({ type: z.literal('schema-update'), expectedRevision: z.number().int().nonnegative(), schema: datasetSchemaSchema }),
  z.strictObject({ type: z.literal('schema-preview'), expectedRevision: z.number().int().nonnegative(),
    schema: datasetSchemaSchema, remaps: classRemapsSchema }),
  z.strictObject({ type: z.literal('schema-apply'), token: z.uuid(), confirmDiscard: z.boolean() }),
  z.strictObject({ type: z.literal('schema-cancel'), token: z.uuid() }),
  z.strictObject({ type: z.literal('status') }),
  z.strictObject({ type: z.literal('create'), passphrase: z.string().min(12).max(1024) }),
  z.strictObject({ type: z.literal('unlock'), passphrase: z.string().min(12).max(1024) }),
  z.strictObject({ type: z.literal('vault-passphrase'), current: z.string().min(12).max(1024), next: z.string().min(12).max(1024) }),
  z.strictObject({ type: z.literal('vault-recovery-create'), current: z.string().min(12).max(1024) }),
  z.strictObject({ type: z.literal('vault-recovery-use'), recovery: recoverySecretSchema, next: z.string().min(12).max(1024) }),
  z.strictObject({ type: z.literal('vault-rotation-start'), current: z.string().min(12).max(1024), next: z.string().min(12).max(1024) }),
  z.strictObject({
    type: z.literal('save'), note: z.string().max(4096),
    name: z.string().min(1).max(256), media: bufferSchema.nullable(),
  }),
  z.strictObject({ type: z.literal('read'), id: z.uuid() }),
  z.strictObject({ type: z.literal('interrupt') }),
  z.strictObject({ type: z.literal('workspace-list'), offset: z.number().int().nonnegative().max(1_000_000), limit: z.number().int().min(1).max(100) }),
  z.strictObject({ type: z.literal('workspace-export-info'), offset: z.number().int().nonnegative().max(10_000), limit: z.number().int().min(1).max(100) }),
  z.strictObject({
    type: z.literal('workspace-import'), document: documentSchema, media: workspaceBufferSchema,
    sourcePath: z.string().min(1).max(1024),
    split: z.enum(['train', 'val', 'test']),
    intakeFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  z.strictObject({ type: z.literal('workspace-read'), id: z.uuid() }),
  z.strictObject({ type: z.literal('workspace-thumbnail'), id: z.uuid() }),
  z.strictObject({ type: z.literal('workspace-mask-read'), id: z.uuid() }),
  z.strictObject({ type: z.literal('workspace-update'), id: z.uuid(), expectedRevision: z.number().int().nonnegative(), document: documentSchema,
    tiles: z.array(maskTileSchema).max(64).optional() }),
  z.strictObject({ type: z.literal('workspace-delete'), id: z.uuid() }),
  z.strictObject({ type: z.literal('share-export-start') }),
  z.strictObject({ type: z.literal('share-publish'), invitation: invitationSchema,
    reviewUrl: z.url().max(8192), name: z.string().trim().min(1).max(100) }),
  z.strictObject({ type: z.literal('share-import-start'), invitation: invitationSchema,
    media: z.instanceof(ArrayBuffer).refine(bytes => bytes.byteLength <= SHARE_BYTES), name: z.string().trim().min(1).max(100) }),
  z.strictObject({ type: z.literal('share-list') }),
  z.strictObject({ type: z.literal('share-proposal'), id: z.uuid(),
    author: z.string().trim().min(1).max(100), message: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal('share-submitted'), id: z.uuid() }),
  z.strictObject({ type: z.literal('share-review'), id: z.uuid(),
    media: z.instanceof(ArrayBuffer).refine(bytes => bytes.byteLength <= MAX_OBJECT_BYTES + 16_384, 'Workspace encrypted proposal exceeds its limit.') }),
  z.strictObject({ type: z.literal('share-decide'), token: z.uuid(), approve: z.boolean() }),
  z.strictObject({ type: z.literal('backup-start'), directory: directorySchema, passphrase: z.string().min(12).max(1024) }),
  z.strictObject({ type: z.literal('restore-start'), directory: directorySchema, passphrase: z.string().min(12).max(1024) }),
  z.strictObject({ type: z.literal('annotation-import-start'), count: z.number().int().min(1).max(10_000) }),
  z.strictObject({ type: z.literal('annotation-import-step'), session: z.uuid(), index: z.number().int().nonnegative().max(9999),
    id: z.uuid(), document: documentSchema, tiles: z.array(maskTileSchema).max(128) }),
  z.strictObject({ type: z.literal('archive-step'), session: z.uuid(), index: z.number().int().min(0).max(10_100) }),
  z.strictObject({ type: z.literal('archive-finish'), session: z.uuid() }),
  z.strictObject({ type: z.literal('archive-cancel'), session: z.uuid() }),
]);
export type StorageRequest = z.infer<typeof storageRequestSchema>;
export const schemaProgressSchema = z.strictObject({
  ready: z.boolean(), completed: z.number().int().nonnegative().max(10_000),
  total: z.number().int().nonnegative().max(10_000), schema: datasetSchemaSchema,
});
export const schemaMigrationPreviewSchema = z.strictObject({
  token: z.uuid(), schema: datasetSchemaSchema,
  discardedCoordinates: z.number().int().nonnegative(),
  affectedAnnotations: z.number().int().nonnegative(),
  images: z.array(z.strictObject({
    id: z.uuid(), name: z.string().min(1).max(256),
    affectedAnnotations: z.number().int().positive(), discardedCoordinates: z.number().int().nonnegative(),
  })).max(10_000),
});
export type SchemaMigrationPreview = z.infer<typeof schemaMigrationPreviewSchema>;
export const statusSchema = z.strictObject({
  exists: z.boolean(), unlocked: z.boolean(), ids: z.array(z.uuid()).max(100),
  recovered: z.number().int().nonnegative(), sqlite: z.string(), vfs: z.literal('opfs-sahpool'),
});
export type VaultStatus = z.infer<typeof statusSchema>;
export const savedSchema = z.strictObject({
  id: z.uuid(), milliseconds: z.number().nonnegative(), mediaBytes: z.number().nonnegative(),
});
export const readSchema = z.strictObject({
  note: z.string().max(4096), name: z.string().min(1).max(256),
  media: z.instanceof(ArrayBuffer).nullable(),
});
export const workspaceListSchema = z.strictObject({
  total: z.number().int().nonnegative().max(10_000),
  items: z.array(z.strictObject({
    id: z.uuid(), name: z.string().min(1).max(256),
    sourcePath: z.string().min(1).max(1024), split: z.enum(['train', 'val', 'test']),
    width: z.number().int().positive(), height: z.number().int().positive(),
    review: z.enum(['unannotated', 'in_progress', 'annotated', 'reviewed']),
    annotationCount: z.number().int().nonnegative(),
    intakeFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })).max(100),
});
export const workspaceExportInfoSchema = z.strictObject({
  total: z.number().int().nonnegative().max(10_000),
  items: z.array(z.strictObject({
    id: z.uuid(), document: documentSchema,
    sourcePath: z.string().min(1).max(1024), split: z.enum(['train', 'val', 'test']),
  })).max(100),
});
export const workspaceReadSchema = z.strictObject({
  document: documentSchema,
  media: z.instanceof(ArrayBuffer),
  sourcePath: z.string().min(1).max(1024),
  split: z.enum(['train', 'val', 'test']),
  intakeFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export const workspaceWriteSchema = z.strictObject({ id: z.uuid(), revision: z.number().int().nonnegative() });
export const thumbnailSchema = z.strictObject({
  media: z.instanceof(ArrayBuffer).refine(bytes => bytes.byteLength <= 128 * 1024),
});
export const maskReadSchema = z.array(maskTileSchema).max(128);
export const workspaceImportSchema = z.strictObject({
  id: z.uuid(), revision: z.number().int().nonnegative(), milliseconds: z.number().nonnegative(),
});
export const workspaceDeleteSchema = z.strictObject({ deleted: z.literal(true) });
export const archiveProgressSchema = z.strictObject({
  session: z.uuid(), count: z.number().int().min(0).max(10_100), completed: z.number().int().min(0).max(10_100),
});
export const archiveFinishedSchema = z.strictObject({ count: z.number().int().min(0).max(10_100), complete: z.literal(true),
  cleanupPending: z.boolean().optional() });
export const passphraseChangedSchema = z.strictObject({ changed: z.literal(true) });
export const mediaRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('sanitize'), file: z.instanceof(File) }),
  z.strictObject({ type: z.literal('file-fingerprint'), file: z.instanceof(File), context: z.string().max(MAX_OBJECT_BYTES) }),
]);
export const fingerprintSchema = z.strictObject({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
export const mediaResultSchema = z.strictObject({
  png: z.instanceof(ArrayBuffer), width: z.number().int().positive(),
  height: z.number().int().positive(), inputBytes: z.number().int().positive(),
  outputBytes: z.number().int().positive(), maxPixelDifference: z.number().int().nonnegative(),
  milliseconds: z.number().nonnegative(), format: z.enum(['JPEG', 'PNG', 'WebP']),
});
export type MediaResult = z.infer<typeof mediaResultSchema>;
export const requestEnvelopeSchema = z.strictObject({
  version: z.literal(1), id: z.number().int().positive(), payload: z.unknown(),
});
export const responseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), id: z.number().int().positive(), ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ version: z.literal(1), id: z.number().int().positive(), ok: z.literal(false), error: z.string().max(512) }),
]);
