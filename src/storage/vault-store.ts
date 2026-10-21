import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { z } from 'zod';
import { changeVaultPassphrase, createDeviceKey, createVaultKey, deviceKeySchema, MAX_OBJECT_BYTES, openDeviceKey, openObject, sealObject, unlockVaultKey, wrappedKeySchema } from '../crypto/vault';
import { verifySanitizedPng } from '../datasets/media';
import { documentSchema } from '../domain/model';
import type { StorageRequest, VaultStatus, WorkspaceDescriptor } from '../workers/protocol';
import { workspaceCatalogSchema, workspaceDescriptorSchema, workspaceIdSchema } from '../workers/protocol';
import { BackupReader, BackupWriter, restoredDocument } from './backup';
import { applyDatasetMigration, applyDatasetSchema, datasetSchemaSchema, emptyDatasetSchema, extendDatasetSchema, mergeDatasetSchema, validateDatasetMigration } from '../domain/dataset-schema';
import type { ClassRemaps, DatasetSchema } from '../domain/dataset-schema';
import type { SchemaMigrationPreview } from '../workers/protocol';
import type { AnnotationDocument } from '../domain/model';
import { checkMaskPayloads, checkTile, maskIds, TILE_BYTES } from '../domain/masks';
import { hex, recoverySecretSchema } from '../crypto/vault';
import type { WrappedKey } from '../crypto/vault';
import type { MaskTile } from '../domain/masks';
import { toBase64Url } from '../collaboration/encoding';
import { ShareArchive } from '../sharing/archive';
import { decryptProposal, encryptProposal, maskDigest, mergeProposal, same } from '../sharing/proposal';
import { proposalSchema, shareReceiptSchema } from '../sharing/model';
import type { ProposalPreview, ShareReceipt, ShareProposal, ShareSummary } from '../sharing/model';

const recordSchema = z.strictObject({
  version: z.literal(1), note: z.string().max(4096), name: z.string().min(1).max(256),
  mediaId: z.uuid().nullable(),
});
const workspaceRecordSchema = z.strictObject({
  version: z.literal(1), document: documentSchema, mediaId: z.uuid(),
  sourcePath: z.string().min(1).max(1024).optional(),
  split: z.enum(['train', 'val', 'test']).optional(),
  intakeFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
let sqliteModule: ReturnType<typeof sqlite3InitModule> | undefined;

export class VaultStore {
  private root: CryptoKey | undefined;
  private workspaceId: string | undefined;
  private recovered = 0;
  private datasetSchema: DatasetSchema | undefined;
  private schemaScan: { ids: string[]; index: number; schema: DatasetSchema } | undefined;
  private schemaMigration: { preview: SchemaMigrationPreview; previous: DatasetSchema; remaps: ClassRemaps } | undefined;
  private masksPruned = false;
  private shareExport: { id: string; key: string; bases: AnnotationDocument[] } | undefined;
  private shareReview: { preview: ProposalPreview; proposal: ShareProposal } | undefined;
  private archive: {
    session: string; index: number; count: number;
    writer?: BackupWriter; reader?: BackupReader; ids: string[]; schema?: DatasetSchema;
    importing?: boolean;
    rotation?: { root: CryptoKey; header: WrappedKey; proofIds: string[]; shareIds: string[] };
    share?: { directory?: ShareArchive; key: string; id: string; bases: AnnotationDocument[]; receipt?: ShareReceipt };
  } | undefined;

  private constructor(
    private readonly db: Database,
    private readonly media: FileSystemDirectoryHandle,
    private readonly sqliteVersion: string,
    private readonly releaseHandles: () => void,
  ) {}

  static async open(scope = 'legacy'): Promise<VaultStore> {
    workspaceIdSchema.parse(scope);
    const sqlite = await (sqliteModule ??= sqlite3InitModule());
    const legacy = scope === 'legacy';
    const pool = await sqlite.installOpfsSAHPoolVfs({
      name: legacy ? 'annotator-phase1' : `annotator-${scope}`,
      directory: legacy ? '.annotator-phase1-sql' : `.annotator-${scope}-sql`, initialCapacity: 6,
    });
    await pool.unpauseVfs();
    const db = new pool.OpfsSAHPoolDb('/proof.sqlite3');
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;');
      const version = db.selectValue('PRAGMA user_version');
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(Number(version))) throw new Error('Unsupported proof database version. Data was not changed.');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), header TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload BLOB NOT NULL, media_id TEXT);
        CREATE TABLE IF NOT EXISTS workspace_records (id TEXT PRIMARY KEY, payload BLOB NOT NULL, media_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS restore_staging (id TEXT PRIMARY KEY, payload BLOB NOT NULL, media_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, password_protected INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dataset_schema (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS mask_objects (id TEXT PRIMARY KEY, image_id TEXT NOT NULL, staged INTEGER NOT NULL CHECK(staged IN (0,1)));
        CREATE INDEX IF NOT EXISTS mask_image ON mask_objects(image_id);
        CREATE TABLE IF NOT EXISTS vault_recovery (id INTEGER PRIMARY KEY CHECK(id=1), header TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rotation_proof (id TEXT PRIMARY KEY, payload BLOB NOT NULL, media_id TEXT);
        CREATE TABLE IF NOT EXISTS thumbnails (image_id TEXT PRIMARY KEY, media_id TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS workspace_shares (id TEXT PRIMARY KEY, payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS rotation_shares (id TEXT PRIMARY KEY, payload BLOB NOT NULL);
        PRAGMA user_version=10;
        COMMIT;`);
      const opfs = await navigator.storage.getDirectory();
      const media = await opfs.getDirectoryHandle(legacy ? 'annotator-phase1-media' : `annotator-${scope}-media`, { create: true });
      const store = new VaultStore(db, media, sqlite.version.libVersion, () => pool.pauseVfs());
      await store.recover();
      return store;
    } catch (error) { db.close(); pool.pauseVfs(); throw error; }
  }
  close(): void { this.root = undefined; this.datasetSchema = undefined; this.schemaScan = undefined; this.schemaMigration = undefined; this.db.close(); this.releaseHandles(); }
  static async openSelected(id: string): Promise<VaultStore> {
    workspaceIdSchema.parse(id);
    const descriptor = (await VaultStore.handleCatalog({ type: 'catalog-list' })).find(item => item.id === id);
    if (!descriptor) throw new Error('Workspace no longer exists in the local catalog.');
    if (descriptor.deleting) throw new Error('Workspace deletion is incomplete. Return to Workspaces and retry Delete to finish removing its local files.');
    const store = await VaultStore.open(id);
    try {
      if (descriptor.passwordProtected) wrappedKeySchema.parse(store.header());
      else {
        const device = deviceKeySchema.parse(store.header());
        store.root = await openDeviceKey(device);
        store.workspaceId = device.workspaceId;
      }
      return store;
    } catch (failure) { store.close(); throw failure; }
  }
  private static async withCatalog<T>(action: (entries: WorkspaceDescriptor[]) => Promise<T>): Promise<T> {
    return navigator.locks.request('annotator-workspace-catalog', async () => {
      const root = await navigator.storage.getDirectory();
      let entries: WorkspaceDescriptor[];
      try {
        const file = await (await root.getFileHandle('annotator-workspaces.json')).getFile();
        if (file.size > 128 * 1024) throw new Error('Workspace catalog exceeds its supported size.');
        entries = workspaceCatalogSchema.parse(JSON.parse(await file.text()));
      } catch (failure) {
        if (!(failure instanceof DOMException && failure.name === 'NotFoundError')) throw failure;
        entries = await navigator.locks.request('annotator-phase1-writer', { ifAvailable: true }, async lock => {
          if (!lock) throw new Error('Workspace catalog needs a one-time upgrade. Exit or reload the workspace in the older tab, then retry here. Saved data has not been changed.');
          const legacy = await VaultStore.open();
          try { return await legacy.catalog(); }
          finally { legacy.close(); }
        });
        await VaultStore.writeCatalog(root, entries);
      }
      return action(entries);
    });
  }
  private static async writeCatalog(root: FileSystemDirectoryHandle, entries: WorkspaceDescriptor[]) {
    const checked = workspaceCatalogSchema.parse(entries);
    const file = await root.getFileHandle('annotator-workspaces.json', { create: true });
    const writer = await file.createWritable();
    try { await writer.write(JSON.stringify(checked)); await writer.close(); }
    catch (failure) { await writer.abort(); throw failure; }
  }
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-list' }>): Promise<WorkspaceDescriptor[]>;
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-create' }>): Promise<WorkspaceDescriptor>;
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-delete' }>): Promise<{ deleted: true }>;
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-list' | 'catalog-create' }>): Promise<WorkspaceDescriptor[] | WorkspaceDescriptor>;
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-list' | 'catalog-create' | 'catalog-delete' }>): Promise<WorkspaceDescriptor[] | WorkspaceDescriptor | { deleted: true }>;
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-list' | 'catalog-create' | 'catalog-delete' }>): Promise<WorkspaceDescriptor[] | WorkspaceDescriptor | { deleted: true }> {
    if (request.type === 'catalog-delete') {
      const scope = workspaceIdSchema.parse(request.workspaceId);
      const lease = scope === 'legacy' ? 'annotator-phase1-writer' : `annotator-workspace-${scope}`;
      return navigator.locks.request(lease, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Workspace is open in another tab. Exit it there before deleting. No data was removed.');
        return VaultStore.withCatalog(async entries => {
          const selected = entries.find(item => item.id === scope);
          if (!selected || selected.name !== request.confirmation) throw new Error('Workspace deletion requires its exact name. No data was removed.');
          const root = await navigator.storage.getDirectory();
          await VaultStore.writeCatalog(root, entries.map(item => item.id === scope ? { ...item, deleting: true } : item));
          const paths = scope === 'legacy'
            ? ['annotator-phase1-media', '.annotator-phase1-sql']
            : [`annotator-${scope}-media`, `.annotator-${scope}-sql`];
          for (const path of paths) {
            try { await root.removeEntry(path, { recursive: true }); }
            catch (error) {
              if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
                throw new Error('Workspace deletion is incomplete. Retry Delete to finish removing its local files. Original folders and other datasets are unchanged.');
              }
            }
          }
          await VaultStore.writeCatalog(root, entries.filter(item => item.id !== scope));
          return { deleted: true as const };
        });
      });
    }
    return VaultStore.withCatalog(async entries => {
      if (request.type === 'catalog-list') return entries;
      if (entries.length >= 100) throw new Error('Workspace limit reached (100 workspaces).');
      if (request.passwordProtected && request.passphrase.length < 12) throw new Error('Use a passphrase of 12 to 1024 characters.');
      const descriptor = workspaceDescriptorSchema.parse({
        id: crypto.randomUUID(), name: request.name, passwordProtected: request.passwordProtected,
        createdAt: new Date().toISOString(),
      });
      const target = await VaultStore.open(descriptor.id);
      try {
        const workspaceId = crypto.randomUUID();
        const result = request.passwordProtected
          ? await createVaultKey(request.passphrase, workspaceId)
          : await createDeviceKey(workspaceId);
        const header = 'wrapped' in result ? result.wrapped : result.header;
        target.db.exec({ sql: 'INSERT INTO vault(id,header) VALUES(1,?)', bind: [JSON.stringify(header)] });
        await VaultStore.writeCatalog(await navigator.storage.getDirectory(), [descriptor, ...entries]);
      } finally { target.close(); }
      return descriptor;
    });
  }
  private async catalog() {
    if (this.header() !== null && !this.db.selectValue("SELECT count(*) FROM workspace_catalog WHERE id='legacy'")) {
      this.db.exec({
        sql: 'INSERT INTO workspace_catalog(id,name,password_protected,created_at) VALUES(?,?,?,?)',
        bind: ['legacy', 'Existing workspace', 1, new Date().toISOString()],
      });
    }
    return workspaceCatalogSchema.parse(this.db.selectObjects(
      'SELECT id,name,password_protected,created_at FROM workspace_catalog ORDER BY created_at DESC,rowid DESC',
    ).map(row => ({ id: row.id, name: row.name, passwordProtected: row.password_protected === 1, createdAt: row.created_at })));
  }

  private async recover(): Promise<void> {
    this.db.exec('DELETE FROM restore_staging');
    this.db.exec('DELETE FROM rotation_proof');
    this.db.exec('DELETE FROM rotation_shares');
    this.db.exec('DELETE FROM mask_objects WHERE staged=1');
    for (const row of this.db.selectObjects('SELECT id FROM intents')) {
      const id = z.uuid().parse(row.id);
      const referenced = this.db.selectValue(
        'SELECT (SELECT count(*) FROM records WHERE media_id=?) + (SELECT count(*) FROM workspace_records WHERE media_id=?) + (SELECT count(*) FROM mask_objects WHERE id=?) + (SELECT count(*) FROM thumbnails WHERE media_id=?)',
        [id, id, id, id],
      );
      if (referenced !== 0) throw new Error('Inconsistent recovery intent: referenced media will not be deleted.');
      try { await this.media.removeEntry(`${id}.enc`); }
      catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
      this.db.exec({ sql: 'DELETE FROM intents WHERE id=?', bind: [id] });
      this.recovered++;
    }
  }
  private header(): unknown {
    const value = this.db.selectValue('SELECT header FROM vault WHERE id=1');
    return typeof value === 'string' ? JSON.parse(value) : null;
  }
  status(): VaultStatus {
    return {
      exists: this.header() !== null, unlocked: this.root !== undefined,
      ids: this.db.selectValues('SELECT id FROM records ORDER BY rowid DESC').map(id => z.uuid().parse(id)),
      recovered: this.recovered, sqlite: this.sqliteVersion, vfs: 'opfs-sahpool',
    };
  }
  async handle(request: StorageRequest): Promise<unknown> {
    if (!['schema-preview', 'schema-apply', 'schema-cancel', 'schema-open', 'status', 'workspace-list',
      'workspace-export-info', 'workspace-read', 'workspace-mask-read', 'workspace-thumbnail', 'read'].includes(request.type)) {
      this.schemaMigration = undefined;
    }
    if (this.schemaScan && !['schema-open', 'schema-step', 'schema-finish', 'status'].includes(request.type)) {
      throw new Error('Workspace schema migration is in progress. Finish it or reopen the workspace before making changes.');
    }
    if (this.archive && !['status', 'archive-step', 'archive-finish', 'archive-cancel', 'annotation-import-step'].includes(request.type)) {
      throw new Error('Workspace backup or restore is in progress. Finish or cancel it before making other changes.');
    }
    switch (request.type) {
      case 'share-list': {
        const summaries: ShareSummary[] = [];
        for (const id of this.shareIds()) {
          const { bases: _bases, maskDigests: _digests, ...summary } = await this.readShare(id);
          summaries.push(summary);
        }
        return summaries;
      }
      case 'share-export-start': {
        this.keys();
        const schema = await this.loadDatasetSchema();
        if (!schema) throw new Error('Workspace schema must be prepared before sharing.');
        if (Number(this.db.selectValue('SELECT count(*) FROM workspace_shares')) >= 100) throw new Error('Workspace share limit reached (100 invitations).');
        const directory = new ShareArchive(), key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
        const writer = await BackupWriter.create(directory, key, schema);
        const ids = this.db.selectValues('SELECT id FROM workspace_records ORDER BY rowid').map(value => z.uuid().parse(value));
        this.shareExport = undefined;
        this.archive = { session: crypto.randomUUID(), index: 0, count: ids.length, ids, writer,
          share: { directory, key, id: writer.id, bases: [] } };
        return { session: this.archive.session, count: ids.length, completed: 0, id: writer.id, key };
      }
      case 'share-publish': {
        const exported = this.shareExport;
        if (!exported || exported.id !== request.invitation.id || exported.key !== request.invitation.key) {
          throw new Error('Workspace share export is no longer available. Publish a new invitation.');
        }
        await this.saveShare({ invitation: request.invitation, role: 'owner', name: request.name,
          reviewUrl: request.reviewUrl, status: 'open', bases: exported.bases });
        this.shareExport = undefined;
        return { complete: true, count: 1 };
      }
      case 'share-import-start': {
        this.keys();
        if (this.db.selectValue('SELECT count(*) FROM workspace_records') !== 0 ||
            this.db.selectValue('SELECT count(*) FROM workspace_shares') !== 0) throw new Error('Workspace share import requires a new empty workspace.');
        const reader = await BackupReader.open(ShareArchive.unpack(request.media), request.invitation.key);
        if (reader.id !== request.invitation.id) throw new Error('Workspace snapshot belongs to a different invitation.');
        this.archive = { session: crypto.randomUUID(), index: 0, count: reader.count, ids: [], reader, schema: reader.schema ?? emptyDatasetSchema(),
          share: { key: request.invitation.key, id: reader.id, bases: [], receipt: {
            invitation: request.invitation, role: 'contributor', name: request.name, reviewUrl: request.invitation.download, status: 'open', bases: [], maskDigests: {},
          } } };
        return { session: this.archive.session, count: reader.count, completed: 0 };
      }
      case 'share-proposal': return this.buildShareProposal(request.id, request.author, request.message);
      case 'share-submitted': {
        const receipt = await this.readShare(request.id);
        if (receipt.role !== 'contributor' || receipt.status !== 'open') throw new Error('Workspace proposal is no longer open.');
        receipt.status = 'submitted'; await this.saveShare(receipt);
        return { complete: true, count: 1 };
      }
      case 'share-review': return this.previewShareProposal(request.id, request.media);
      case 'share-decide': return this.decideShareProposal(request.token, request.approve);
      case 'catalog-list':
      case 'catalog-create':
      case 'catalog-delete': throw new Error('Workspace must be exited before changing the workspace catalog.');
      case 'workspace-open': return this.status();
      case 'vault-recovery-create': {
        const { workspaceId } = this.keys();
        const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
        const header = await changeVaultPassphrase(request.current, secret, this.header());
        this.db.exec({ sql: 'INSERT OR REPLACE INTO vault_recovery(id,header) VALUES(1,?)', bind: [JSON.stringify(header)] });
        return recoverySecretSchema.parse({ format: 'annotator-recovery-secret', version: 1, workspaceId, secret });
      }
      case 'vault-recovery-use': {
        const previous = wrappedKeySchema.parse(this.header());
        if (previous.workspaceId !== request.recovery.workspaceId) throw new Error('Workspace recovery file belongs to a different workspace.');
        const stored = this.db.selectValue('SELECT header FROM vault_recovery WHERE id=1');
        if (typeof stored !== 'string') throw new Error('Workspace has no recovery secret. Use the passphrase or restore an encrypted backup.');
        const recovery = wrappedKeySchema.parse(JSON.parse(stored));
        if (recovery.workspaceId !== previous.workspaceId) throw new Error('Workspace recovery header is invalid.');
        const header = await changeVaultPassphrase(request.recovery.secret, request.next, recovery);
        this.db.exec({ sql: 'UPDATE vault SET header=? WHERE id=1', bind: [JSON.stringify(header)] });
        this.root = await unlockVaultKey(request.next, header); this.workspaceId = header.workspaceId;
        return this.status();
      }
      case 'vault-rotation-start': {
        const { workspaceId } = this.keys();
        await unlockVaultKey(request.current, this.header());
        const schema = await this.loadDatasetSchema();
        if (!schema) throw new Error('Workspace schema must be prepared before rotating its key.');
        const { root, wrapped } = await createVaultKey(request.next, workspaceId);
        const ids = this.db.selectValues('SELECT id FROM workspace_records ORDER BY rowid').map(value => z.uuid().parse(value));
        const proofIds = this.db.selectValues('SELECT id FROM records ORDER BY rowid').map(value => z.uuid().parse(value));
        const shareIds = this.shareIds();
        this.archive = { session: crypto.randomUUID(), index: 0, count: ids.length + proofIds.length + shareIds.length, ids, schema,
          rotation: { root, header: wrapped, proofIds, shareIds } };
        return { session: this.archive.session, count: this.archive.count, completed: 0 };
      }
      case 'schema-open': {
        this.keys();
        if (!this.masksPruned) { await this.pruneMasks(); this.masksPruned = true; }
        const schema = await this.loadDatasetSchema();
        if (schema) return { ready: true, completed: 0, total: 0, schema };
        this.schemaScan ??= {
          ids: this.db.selectValues('SELECT id FROM workspace_records ORDER BY rowid').map(id => z.uuid().parse(id)),
          index: 0, schema: emptyDatasetSchema(),
        };
        return this.schemaProgress();
      }
      case 'schema-step': {
        const scan = this.schemaScan;
        if (!scan || request.index !== scan.index || scan.index >= scan.ids.length) {
          throw new Error('Workspace schema migration step is out of order.');
        }
        const record = await this.readWorkspaceRecord(scan.ids[scan.index]!);
        scan.schema = mergeDatasetSchema(scan.schema, record.document);
        scan.index++;
        return this.schemaProgress();
      }
      case 'schema-finish': {
        const scan = this.schemaScan;
        if (!scan || scan.index !== scan.ids.length) throw new Error('Workspace schema migration is incomplete.');
        const encrypted = await this.sealDatasetSchema(scan.schema);
        this.db.exec({ sql: 'INSERT INTO dataset_schema(id,payload) VALUES(1,?)', bind: [encrypted] });
        this.datasetSchema = scan.schema;
        this.schemaScan = undefined;
        return { ready: true, completed: scan.index, total: scan.ids.length, schema: scan.schema };
      }
      case 'schema-update': {
        const previous = await this.loadDatasetSchema();
        if (!previous || previous.revision !== request.expectedRevision) throw new Error('Workspace schema changed; reopen before saving.');
        const next = extendDatasetSchema(previous, request.schema);
        const encrypted = await this.sealDatasetSchema(next);
        this.db.exec({ sql: 'UPDATE dataset_schema SET payload=? WHERE id=1', bind: [encrypted] });
        this.datasetSchema = next;
        return { ready: true, completed: 0, total: 0, schema: next };
      }
      case 'schema-preview': return this.previewSchemaMigration(request);
      case 'schema-apply': return this.applySchemaMigration(request.token, request.confirmDiscard);
      case 'schema-cancel': {
        if (this.schemaMigration?.preview.token !== request.token) throw new Error('Workspace schema migration preview is stale. Preview again.');
        this.schemaMigration = undefined;
        return { complete: true, count: 0 };
      }
      case 'status': return this.status();
      case 'create': {
        if (this.header() !== null) throw new Error('A proof vault already exists. Unlock it instead.');
        const workspaceId = crypto.randomUUID();
        const { root, wrapped } = await createVaultKey(request.passphrase, workspaceId);
        this.db.exec({ sql: 'INSERT INTO vault(id,header) VALUES(1,?)', bind: [JSON.stringify(wrapped)] });
        this.root = root; this.workspaceId = workspaceId;
        await VaultStore.withCatalog(async entries => {
          if (!entries.some(item => item.id === 'legacy')) {
            await VaultStore.writeCatalog(await navigator.storage.getDirectory(), [
              ...entries, workspaceDescriptorSchema.parse({
                id: 'legacy', name: 'Existing workspace', passwordProtected: true, createdAt: new Date().toISOString(),
              }),
            ]);
          }
        });
        return this.status();
      }
      case 'unlock': {
        if (this.root) throw new Error('The proof vault is already unlocked.');
        const header = wrappedKeySchema.parse(this.header());
        const root = await unlockVaultKey(request.passphrase, header);
        this.root = root; this.workspaceId = header.workspaceId;
        return this.status();
      }
      case 'vault-passphrase': {
        this.keys();
        const wrapped = await changeVaultPassphrase(request.current, request.next, this.header());
        this.db.transaction(() => {
          this.db.exec({ sql: 'UPDATE vault SET header=? WHERE id=1', bind: [JSON.stringify(wrapped)] });
        });
        return { changed: true };
      }
      case 'save': return this.save(request.note, request.name, request.media, false);
      case 'read': return this.read(request.id);
      case 'workspace-list': return this.listWorkspace(request.offset, request.limit);
      case 'workspace-export-info': return this.listWorkspaceExportInfo(request.offset, request.limit);
      case 'workspace-import': return this.importWorkspaceImage(
        request.document, request.media, request.sourcePath, request.split, request.intakeFingerprint,
      );
      case 'workspace-read': return this.readWorkspaceImage(request.id);
      case 'workspace-thumbnail': return this.readThumbnail(request.id);
      case 'workspace-mask-read': return this.readMaskTiles(request.id);
      case 'workspace-update': return this.updateWorkspaceImage(request.id, request.expectedRevision, request.document, request.tiles);
      case 'workspace-delete': return this.deleteWorkspaceImage(request.id);
      case 'backup-start': {
        this.keys();
        const writer = await BackupWriter.create(request.directory, request.passphrase, await this.loadDatasetSchema());
        const ids = this.db.selectValues('SELECT id FROM workspace_records ORDER BY rowid DESC').map(id => z.uuid().parse(id));
        this.archive = { session: crypto.randomUUID(), index: 0, count: ids.length, ids, writer };
        return { session: this.archive.session, count: ids.length, completed: 0 };
      }
      case 'restore-start': {
        this.keys();
        if (this.db.selectValue('SELECT count(*) FROM workspace_records') !== 0) {
          throw new Error('Workspace must be empty before restoring a backup. Existing images were not changed. Exit and create a new workspace to restore into.');
        }
        const reader = await BackupReader.open(request.directory, request.passphrase);
        const schema = mergeDatasetSchema(await this.loadDatasetSchema() ?? emptyDatasetSchema(), reader.schema ?? emptyDatasetSchema());
        this.archive = { session: crypto.randomUUID(), index: 0, count: reader.count, ids: [], reader, schema };
        return { session: this.archive.session, count: reader.count, completed: 0 };
      }
      case 'archive-step': return this.archiveStep(request.session, request.index);
      case 'annotation-import-start': {
        this.keys();
        const schema = await this.loadDatasetSchema();
        if (!schema) throw new Error('Workspace schema must be prepared before annotation import.');
        this.archive = { session: crypto.randomUUID(), index: 0, count: request.count, ids: [], schema, importing: true };
        return { session: this.archive.session, count: request.count, completed: 0 };
      }
      case 'annotation-import-step': return this.stageAnnotationImport(request);
      case 'archive-finish': return this.archiveFinish(request.session);
      case 'archive-cancel': {
        const archive = this.getArchive(request.session);
        await this.recover();
        this.archive = undefined;
        return { count: archive.index, complete: true };
      }
      case 'interrupt':
        // This lab-only operation writes synthetic bytes, never an interrupted user edit.
        return this.save('synthetic interrupted-write proof', 'synthetic-proof.png', new Uint8Array([1, 2, 3]).buffer, true);
    }
  }
  private keys(): { root: CryptoKey; workspaceId: string } {
    if (!this.root || !this.workspaceId) throw new Error('Unlock the proof vault first.');
    return { root: this.root, workspaceId: this.workspaceId };
  }
  private async previewSchemaMigration(request: Extract<StorageRequest, { type: 'schema-preview' }>) {
    this.schemaMigration = undefined;
    const previous = await this.loadDatasetSchema();
    if (!previous || previous.revision !== request.expectedRevision) throw new Error('Workspace schema changed; reopen before saving.');
    const schema = validateDatasetMigration(previous, request.schema, request.remaps);
    const preview: SchemaMigrationPreview = {
      token: crypto.randomUUID(), schema, discardedCoordinates: 0, affectedAnnotations: 0, images: [],
    };
    for (const value of this.db.selectValues('SELECT id FROM workspace_records ORDER BY rowid')) {
      const record = await this.readWorkspaceRecord(z.uuid().parse(value));
      const result = applyDatasetMigration(record.document, previous, schema, request.remaps);
      preview.discardedCoordinates += result.discardedCoordinates;
      preview.affectedAnnotations += result.affectedAnnotations;
      if (result.affectedAnnotations) preview.images.push({
        id: record.document.image.id, name: record.document.image.name,
        affectedAnnotations: result.affectedAnnotations, discardedCoordinates: result.discardedCoordinates,
      });
    }
    this.schemaMigration = { preview, previous, remaps: structuredClone(request.remaps) };
    return preview;
  }
  private async applySchemaMigration(token: string, confirmDiscard: boolean) {
    const migration = this.schemaMigration;
    if (!migration || migration.preview.token !== token) throw new Error('Workspace schema migration preview is stale. Preview again.');
    const { preview, previous, remaps } = migration;
    const current = await this.loadDatasetSchema();
    if (!current || current.revision !== previous.revision) throw new Error('Workspace schema changed; preview again.');
    if (preview.discardedCoordinates && !confirmDiscard) throw new Error('Workspace migration requires confirmation to discard the previewed point coordinates.');
    const { root, workspaceId } = this.keys();
    this.schemaMigration = undefined;
    this.db.exec('DELETE FROM restore_staging');
    try {
      const ids = this.db.selectValues('SELECT id FROM workspace_records ORDER BY rowid').map(value => z.uuid().parse(value));
      for (const id of ids) {
        const record = await this.readWorkspaceRecord(id);
        const result = applyDatasetMigration(record.document, previous, preview.schema, remaps);
        const document = documentSchema.parse({ ...result.document, revision: record.document.revision + 1 });
        const bytes = encoder.encode(JSON.stringify(workspaceRecordSchema.parse({ ...record, document })));
        if (bytes.length > MAX_OBJECT_BYTES) throw new Error('Annotation document exceeds the 8 MiB limit.');
        const payload = await sealObject(root, workspaceId, id, bytes, 'record');
        this.db.exec({ sql: 'INSERT INTO restore_staging(id,payload,media_id) VALUES(?,?,?)', bind: [id, payload, record.mediaId] });
      }
      const encrypted = await this.sealDatasetSchema(preview.schema);
      this.db.transaction(() => {
        this.db.exec('UPDATE workspace_records SET payload=(SELECT payload FROM restore_staging WHERE restore_staging.id=workspace_records.id)');
        this.db.exec({ sql: 'UPDATE dataset_schema SET payload=? WHERE id=1', bind: [encrypted] });
        this.db.exec('DELETE FROM restore_staging');
      });
      this.datasetSchema = preview.schema;
      return { ready: true, completed: ids.length, total: ids.length, schema: preview.schema };
    } finally {
      this.db.exec('DELETE FROM restore_staging');
    }
  }
  private schemaProgress() {
    const scan = this.schemaScan;
    if (!scan) throw new Error('Workspace schema migration is not active.');
    return { ready: false, completed: scan.index, total: scan.ids.length, schema: scan.schema };
  }
  private async sealDatasetSchema(schema: DatasetSchema) {
    const { root, workspaceId } = this.keys();
    return sealObject(root, workspaceId, workspaceId, encoder.encode(JSON.stringify(datasetSchemaSchema.parse(schema))), 'schema');
  }
  private async loadDatasetSchema(): Promise<DatasetSchema | undefined> {
    if (this.datasetSchema) return this.datasetSchema;
    const { root, workspaceId } = this.keys();
    const payload = this.db.selectValue('SELECT payload FROM dataset_schema WHERE id=1');
    if (payload === undefined) return undefined;
    if (!(payload instanceof Uint8Array)) throw new Error('Workspace schema record is invalid.');
    this.datasetSchema = datasetSchemaSchema.parse(JSON.parse(decoder.decode(
      await openObject(root, workspaceId, workspaceId, new Uint8Array(payload), 'schema'),
    )));
    return this.datasetSchema;
  }
  private async effectiveDocument(document: AnnotationDocument) {
    const schema = await this.loadDatasetSchema();
    return schema ? applyDatasetSchema(document, schema) : document;
  }
  private async readWorkspaceRecord(id: string) {
    const { root, workspaceId } = this.keys();
    const row = this.db.selectObjects('SELECT payload,media_id FROM workspace_records WHERE id=?', [id])[0];
    if (!row || !(row.payload instanceof Uint8Array) || typeof row.media_id !== 'string') throw new Error('Workspace image not found.');
    const record = workspaceRecordSchema.parse(JSON.parse(decoder.decode(
      await openObject(root, workspaceId, id, new Uint8Array(row.payload), 'record'),
    )));
    if (record.mediaId !== row.media_id || record.document.image.id !== id ||
        record.document.image.mediaId !== record.mediaId) throw new Error('Workspace image reference authentication mismatch.');
    return record;
  }
  private async readMaskTiles(id: string): Promise<MaskTile[]> {
    const { root, workspaceId } = this.keys();
    const record = await this.readWorkspaceRecord(id);
    const result: MaskTile[] = [];
    for (const tileId of maskIds(record.document)) {
      if (!this.db.selectValue('SELECT count(*) FROM mask_objects WHERE id=? AND image_id=? AND staged=0', [tileId, id])) {
        throw new Error('Workspace mask reference is not committed to this image.');
      }
      const file = await (await this.media.getFileHandle(`${tileId}.enc`)).getFile();
      if (file.size > TILE_BYTES + 16384) throw new Error('Workspace mask tile exceeds its size limit.');
      const pixels = await openObject(root, workspaceId, tileId, new Uint8Array(await file.arrayBuffer()), 'mask');
      checkTile(pixels);
      result.push({ id: tileId, pixels: pixels.buffer });
    }
    return result;
  }
  private async pruneMasks() {
    for (const imageId of this.db.selectValues('SELECT DISTINCT image_id FROM mask_objects WHERE staged=0')) {
      const id = z.uuid().parse(imageId);
      const referenced = new Set(maskIds((await this.readWorkspaceRecord(id)).document));
      const unused = this.db.selectValues('SELECT id FROM mask_objects WHERE image_id=? AND staged=0', [id])
        .map(value => z.uuid().parse(value)).filter(tileId => !referenced.has(tileId));
      this.db.transaction(() => {
        for (const tileId of unused) {
          this.db.exec({ sql: 'INSERT INTO intents(id) VALUES(?)', bind: [tileId] });
          this.db.exec({ sql: 'DELETE FROM mask_objects WHERE id=?', bind: [tileId] });
        }
      });
    }
    await this.recover();
  }
  private async prepareMaskTiles(imageId: string, document: AnnotationDocument, tiles: MaskTile[]) {
    const ids = new Set(maskIds(document)), supplied = new Set(tiles.map(tile => tile.id));
    if (supplied.size !== tiles.length || tiles.some(tile => !ids.has(tile.id))) throw new Error('Workspace mask update has duplicate or unused tiles.');
    const existing = new Set(this.db.selectValues('SELECT id FROM mask_objects WHERE image_id=? AND staged=0', [imageId]));
    if (existing.size + tiles.length > 512) throw new Error('Workspace mask history reached 32 MiB for this image. Exit and reopen to release old mask history.');
    for (const tileId of ids) if (!supplied.has(tileId) && !existing.has(tileId)) throw new Error('Workspace mask tile is missing or belongs to another image.');
    const { root, workspaceId } = this.keys();
    for (const tile of tiles) {
      checkTile(new Uint8Array(tile.pixels));
      if (this.db.selectValue('SELECT count(*) FROM mask_objects WHERE id=?', [tile.id])) throw new Error('Workspace mask tile ID already exists.');
      const reference = document.annotations.flatMap(item => item.kind === 'mask' ? item.tiles : []).find(item => item.blobId === tile.id)!;
      const size = document.image.canonical, pixels = new Uint8Array(tile.pixels);
      if (pixels.some((value, index) => value !== 0 &&
          (reference.x + index % 256 >= size.width || reference.y + Math.floor(index / 256) >= size.height))) {
        throw new Error('Workspace mask tile contains pixels outside the image.');
      }
    }
    for (const tile of tiles) {
      await this.stageMedia(tile.id, await sealObject(root, workspaceId, tile.id, new Uint8Array(tile.pixels), 'mask'), 'Encrypted media');
    }
  }
  private async readShare(id: string): Promise<ShareReceipt> {
    const { root, workspaceId } = this.keys();
    const payload = this.db.selectValue('SELECT payload FROM workspace_shares WHERE id=?', [id]);
    if (!(payload instanceof Uint8Array)) throw new Error('Workspace invitation no longer exists.');
    return shareReceiptSchema.parse(JSON.parse(decoder.decode(await openObject(root, workspaceId, id, new Uint8Array(payload), 'record'))));
  }
  private shareIds(): string[] {
    return this.db.selectValues('SELECT id FROM workspace_shares ORDER BY rowid DESC').map(id => z.uuid().parse(id));
  }
  private async sealShare(receipt: ShareReceipt, root = this.keys().root) {
    const bytes = encoder.encode(JSON.stringify(shareReceiptSchema.parse(receipt)));
    if (bytes.length > MAX_OBJECT_BYTES) throw new Error('Workspace share annotation history exceeds 8 MiB. Share a smaller dataset.');
    return sealObject(root, this.keys().workspaceId, receipt.invitation.id, bytes, 'record');
  }
  private async saveShare(receipt: ShareReceipt) {
    const payload = await this.sealShare(receipt);
    this.db.exec({ sql: 'INSERT OR REPLACE INTO workspace_shares(id,payload) VALUES(?,?)', bind: [receipt.invitation.id, payload] });
  }
  private async buildShareProposal(id: string, author: string, message: string) {
    const receipt = await this.readShare(id);
    if (receipt.role !== 'contributor' || receipt.status !== 'open') throw new Error('Workspace invitation already has a submitted proposal.');
    if (receipt.invitation.expires && Date.parse(receipt.invitation.expires) <= Date.now()) throw new Error('Workspace invitation expired. Your local edits are safe; ask the owner for a new invitation.');
    const changes: ShareProposal['changes'] = [];
    for (const base of receipt.bases) {
      const local = (await this.readWorkspaceImage(base.image.id)).document;
      const next = documentSchema.parse({ ...local, image: base.image });
      const masks = next.annotations.filter(item => item.kind === 'mask');
      if (masks.length) {
        const tiles = await this.readMaskTiles(base.image.id);
        for (const mask of masks) {
          if (receipt.maskDigests?.[`${base.image.id}/${mask.id}`] === await maskDigest(mask, tiles)) {
            const original = base.annotations.find(item => item.id === mask.id);
            if (original) next.annotations[next.annotations.findIndex(item => item.id === mask.id)] = original;
          }
        }
      }
      mergeProposal(base, next, base);
      if (!same(base.annotations, next.annotations) || base.review !== next.review) changes.push({ base, next });
    }
    if (!changes.length) throw new Error('Workspace has no annotation changes to submit.');
    const proposal = proposalSchema.parse({ version: 1, shareId: id, author, message, changes });
    return { media: await encryptProposal(receipt.invitation, proposal), count: changes.length };
  }
  private async mergeShareProposal(receipt: ShareReceipt, proposal: ShareProposal) {
    if (receipt.role !== 'owner' || receipt.status !== 'open') throw new Error('Workspace proposal has already been reviewed.');
    const bases = new Map(receipt.bases.map(base => [base.image.id, base]));
    const seen = new Set<string>();
    const documents: AnnotationDocument[] = [], conflicts: string[] = [];
    for (const change of proposal.changes) {
      const id = change.base.image.id;
      if (seen.has(id) || !same(bases.get(id), change.base)) throw new Error('Workspace proposal does not match the original shared snapshot.');
      seen.add(id);
      try {
        const latest = (await this.readWorkspaceRecord(id)).document;
        documents.push(mergeProposal(change.base, change.next, await this.effectiveDocument(latest)));
      } catch (failure) {
        conflicts.push(`${change.base.image.name}: ${failure instanceof Error ? failure.message : 'Unable to merge this image.'}`);
      }
    }
    return { documents, conflicts };
  }
  private async previewShareProposal(id: string, bytes: ArrayBuffer): Promise<ProposalPreview> {
    this.shareReview = undefined;
    const receipt = await this.readShare(id), proposal = await decryptProposal(receipt.invitation, bytes);
    const { conflicts } = await this.mergeShareProposal(receipt, proposal);
    const preview: ProposalPreview = {
      token: crypto.randomUUID(), shareId: id, author: proposal.author, message: proposal.message, conflicts,
      images: proposal.changes.map(({ base, next }) => ({
        id: base.image.id, name: base.image.name,
        added: next.annotations.filter(item => !base.annotations.some(old => old.id === item.id)).length,
        changed: next.annotations.filter(item => base.annotations.some(old => old.id === item.id && !same(old, item))).length,
        removed: base.annotations.filter(item => !next.annotations.some(changed => changed.id === item.id)).length,
        reviewChanged: base.review !== next.review,
        reviewBefore: base.review, reviewAfter: next.review,
        edits: [...new Set([...base.annotations.map(item => item.id), ...next.annotations.map(item => item.id)])]
          .filter(id => !same(base.annotations.find(item => item.id === id), next.annotations.find(item => item.id === id)))
          .map(id => ({ id, before: base.annotations.find(item => item.id === id) ?? null, after: next.annotations.find(item => item.id === id) ?? null })),
      })),
    };
    this.shareReview = { preview, proposal };
    return preview;
  }
  private async decideShareProposal(token: string, approve: boolean) {
    const review = this.shareReview;
    if (!review || review.preview.token !== token) throw new Error('Workspace proposal preview is stale. Check the proposal again.');
    const receipt = await this.readShare(review.preview.shareId);
    if (receipt.role !== 'owner' || receipt.status !== 'open') throw new Error('Workspace proposal has already been reviewed.');
    const rows: { id: string; payload: Uint8Array<ArrayBuffer> }[] = [];
    if (approve) {
      const { documents, conflicts } = await this.mergeShareProposal(receipt, review.proposal);
      if (conflicts.length) throw new Error(`Workspace proposal conflicts with current edits. No changes were approved. ${conflicts.join(' ')}`);
      const { root, workspaceId } = this.keys();
      for (const document of documents) {
        const previous = await this.readWorkspaceRecord(document.image.id);
        const bytes = encoder.encode(JSON.stringify({ ...previous, document }));
        if (bytes.length > MAX_OBJECT_BYTES) throw new Error('Annotation document exceeds 8 MiB.');
        rows.push({ id: document.image.id, payload: await sealObject(root, workspaceId, document.image.id, bytes, 'record') });
      }
    }
    receipt.status = approve ? 'approved' : 'rejected';
    const encryptedReceipt = await this.sealShare(receipt);
    this.db.transaction(() => {
      for (const row of rows) this.db.exec({ sql: 'UPDATE workspace_records SET payload=? WHERE id=?', bind: [row.payload, row.id] });
      this.db.exec({ sql: 'UPDATE workspace_shares SET payload=? WHERE id=?', bind: [encryptedReceipt, receipt.invitation.id] });
    });
    this.shareReview = undefined;
    return { complete: true, count: rows.length };
  }
  private getArchive(session: string) {
    if (!this.archive || this.archive.session !== session) throw new Error('Workspace backup or restore session is no longer active.');
    return this.archive;
  }
  private async stageAnnotationImport(request: Extract<StorageRequest, { type: 'annotation-import-step' }>) {
    const archive = this.getArchive(request.session);
    if (!archive.importing || archive.index !== request.index || request.index >= archive.count || archive.ids.includes(request.id)) {
      throw new Error('Workspace annotation import step is out of order or repeats an image.');
    }
    const previous = await this.readWorkspaceRecord(request.id);
    if (JSON.stringify(previous.document.image.canonical) !== JSON.stringify(request.document.image.canonical)) {
      throw new Error('Workspace annotation dimensions do not match the destination image.');
    }
    checkMaskPayloads(request.document, request.tiles);
    const schema = mergeDatasetSchema(archive.schema!, request.document);
    const document = applyDatasetSchema({ ...request.document, image: previous.document.image, revision: previous.document.revision + 1 }, schema);
    const rebound = new Map(request.tiles.map(tile => [tile.id, crypto.randomUUID()]));
    for (const annotation of document.annotations) if (annotation.kind === 'mask') {
      annotation.tiles = annotation.tiles.map(tile => ({ ...tile, blobId: rebound.get(tile.blobId)! }));
    }
    const tiles = request.tiles.map(tile => ({ ...tile, id: rebound.get(tile.id)! }));
    const { root, workspaceId } = this.keys();
    const bytes = encoder.encode(JSON.stringify({ ...previous, document }));
    if (bytes.length > MAX_OBJECT_BYTES) throw new Error('Annotation document exceeds the 8 MiB limit.');
    const payload = await sealObject(root, workspaceId, request.id, bytes, 'record');
    await this.prepareMaskTiles(request.id, document, tiles);
    this.db.transaction(() => {
      this.db.exec({ sql: 'INSERT INTO restore_staging(id,payload,media_id) VALUES(?,?,?)', bind: [request.id, payload, previous.mediaId] });
      for (const tile of tiles) this.db.exec({ sql: 'INSERT INTO mask_objects(id,image_id,staged) VALUES(?,?,1)', bind: [tile.id, request.id] });
    });
    archive.schema = schema; archive.ids.push(request.id); archive.index++;
    return { session: archive.session, count: archive.count, completed: archive.index };
  }
  private async stageMedia(
    mediaId: string, encrypted: Uint8Array<ArrayBuffer>,
    description: 'Encrypted media' | 'Encrypted image' | 'Workspace restore media',
  ): Promise<void> {
    const referenced = this.db.selectValue(
      'SELECT (SELECT count(*) FROM records WHERE media_id=?) + (SELECT count(*) FROM workspace_records WHERE media_id=?) + (SELECT count(*) FROM restore_staging WHERE media_id=?) + (SELECT count(*) FROM mask_objects WHERE id=?) + (SELECT count(*) FROM thumbnails WHERE media_id=?)',
      [mediaId, mediaId, mediaId, mediaId, mediaId],
    );
    if (referenced !== 0) throw new Error(`${description} ID is already referenced. Existing media was not changed.`);
    this.db.exec({ sql: 'INSERT INTO intents(id) VALUES(?)', bind: [mediaId] });
    const handle = await this.media.getFileHandle(`${mediaId}.enc`, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(encrypted); await writable.close(); }
    catch (failure) {
      try { await writable.abort(); }
      catch { throw new Error(`${description} write and cleanup failed. Reopen the workspace to recover.`); }
      throw failure;
    }
    const file = await handle.getFile();
    if (file.size !== encrypted.byteLength) throw new Error(`${description} write was incomplete.`);
    const readback = new Uint8Array(await file.arrayBuffer());
    if (readback.some((byte, offset) => byte !== encrypted[offset])) throw new Error(`${description} verification failed.`);
  }
  private async archiveStep(session: string, index: number) {
    const archive = this.getArchive(session);
    if (archive.index !== index || index >= archive.count) throw new Error('Workspace archive step is out of order.');
    if (archive.rotation) {
      await this.rotateItem(index);
    } else if (archive.writer) {
      const image = await this.readWorkspaceImage(archive.ids[index]!);
      await archive.writer.append({
        document: image.document, sourcePath: image.sourcePath, split: image.split,
      }, new Uint8Array(image.media), await this.readMaskTiles(image.document.image.id));
      archive.share?.bases.push(image.document);
    } else if (archive.reader) {
      const { record, media, tiles } = await archive.reader.read(index);
      archive.share?.bases.push(record.document);
      if (archive.share?.receipt) {
        for (const annotation of record.document.annotations) if (annotation.kind === 'mask') {
          archive.share.receipt.maskDigests![`${record.document.image.id}/${annotation.id}`] = await maskDigest(annotation, tiles);
        }
      }
      archive.schema = mergeDatasetSchema(archive.schema ?? emptyDatasetSchema(), record.document);
      const { root, workspaceId } = this.keys();
      const document = restoredDocument(record.document, workspaceId);
      const rebound = new Map(tiles.map(tile => [tile.id, crypto.randomUUID()]));
      for (const annotation of document.annotations) if (annotation.kind === 'mask') {
        annotation.tiles = annotation.tiles.map(tile => ({ ...tile, blobId: rebound.get(tile.blobId)! }));
      }
      const id = document.image.id, mediaId = document.image.mediaId;
      const maskTiles = tiles.map(tile => ({ ...tile, id: rebound.get(tile.id)! }));
      await this.prepareMaskTiles(id, document, maskTiles);
      const payload = await sealObject(root, workspaceId, id, encoder.encode(JSON.stringify(
        workspaceRecordSchema.parse({ version: 1, document, mediaId, sourcePath: record.sourcePath, split: record.split }),
      )), 'record');
      const encrypted = await sealObject(root, workspaceId, mediaId, media, 'media');
      await this.stageMedia(mediaId, encrypted, 'Workspace restore media');
      this.db.transaction(() => {
        this.db.exec({ sql: 'INSERT INTO restore_staging(id,payload,media_id) VALUES(?,?,?)', bind: [id, payload, mediaId] });
        for (const tile of maskTiles) this.db.exec({
          sql: 'INSERT INTO mask_objects(id,image_id,staged) VALUES(?,?,1)', bind: [tile.id, id],
        });
      });
    } else throw new Error('Workspace archive session is invalid.');
    archive.index++;
    return { session, count: archive.count, completed: archive.index };
  }
  private async archiveFinish(session: string) {
    const archive = this.getArchive(session);
    if (archive.index !== archive.count) throw new Error('Workspace archive is incomplete; no restore was committed.');
    if (archive.rotation) return this.finishRotation();
    if (archive.writer) {
      await archive.writer.finish();
      if (archive.share?.directory) {
        const share = archive.share;
        if (encoder.encode(JSON.stringify(share.bases)).length > MAX_OBJECT_BYTES - 32_768) {
          throw new Error('Workspace share annotation history exceeds 8 MiB. Share a smaller dataset.');
        }
        this.shareExport = { id: share.id, key: share.key, bases: share.bases };
        const media = share.directory!.pack();
        this.archive = undefined;
        return { count: archive.count, complete: true, media };
      }
    }
    if (archive.reader || archive.importing) {
      const merged = archive.schema ?? emptyDatasetSchema();
      const schema = { ...merged, revision: merged.revision + 1 };
      const encryptedSchema = await this.sealDatasetSchema(schema);
      const receipt = archive.share?.receipt;
      if (receipt) receipt.bases = archive.share!.bases;
      const encryptedReceipt = receipt ? await this.sealShare(receipt) : undefined;
      if ((!archive.importing && this.db.selectValue('SELECT count(*) FROM workspace_records') !== 0) ||
          this.db.selectValue('SELECT count(*) FROM restore_staging') !== archive.count) {
        throw new Error('Workspace changed during restore. No staged images were committed.');
      }
      this.db.transaction(() => {
        if (archive.importing) this.db.exec(`UPDATE workspace_records SET
          payload=(SELECT payload FROM restore_staging WHERE restore_staging.id=workspace_records.id)
          WHERE id IN (SELECT id FROM restore_staging)`);
        else this.db.exec('INSERT INTO workspace_records(id,payload,media_id) SELECT id,payload,media_id FROM restore_staging ORDER BY rowid DESC');
        this.db.exec('DELETE FROM intents WHERE id IN (SELECT media_id FROM restore_staging)');
        this.db.exec('DELETE FROM restore_staging');
        this.db.exec('DELETE FROM intents WHERE id IN (SELECT id FROM mask_objects WHERE staged=1)');
        this.db.exec('UPDATE mask_objects SET staged=0 WHERE staged=1');
        this.db.exec({ sql: 'INSERT OR REPLACE INTO dataset_schema(id,payload) VALUES(1,?)', bind: [encryptedSchema] });
        if (receipt && encryptedReceipt) {
          this.db.exec({ sql: 'INSERT INTO workspace_shares(id,payload) VALUES(?,?)', bind: [receipt.invitation.id, encryptedReceipt] });
        }
      });
      this.datasetSchema = schema;
    }
    this.archive = undefined;
    return { count: archive.count, complete: true };
  }
  private async rotateItem(index: number) {
    const archive = this.archive!, rotation = archive.rotation!, { root, workspaceId } = this.keys();
    if (index < archive.ids.length) {
      const id = archive.ids[index]!, image = await this.readWorkspaceImage(id);
      const tiles = await this.readMaskTiles(id);
      const rebound = new Map(tiles.map(tile => [tile.id, crypto.randomUUID()]));
      for (const annotation of image.document.annotations) if (annotation.kind === 'mask') {
        annotation.tiles = annotation.tiles.map(tile => ({ ...tile, blobId: rebound.get(tile.blobId)! }));
      }
      const mediaId = crypto.randomUUID();
      image.document.image.mediaId = mediaId;
      const payload = await sealObject(rotation.root, workspaceId, id, encoder.encode(JSON.stringify({
        version: 1, document: image.document, mediaId, sourcePath: image.sourcePath, split: image.split,
        intakeFingerprint: image.intakeFingerprint,
      })), 'record');
      await this.stageMedia(mediaId, await sealObject(rotation.root, workspaceId, mediaId, new Uint8Array(image.media), 'media'), 'Encrypted media');
      for (const tile of tiles) {
        const tileId = rebound.get(tile.id)!;
        await this.stageMedia(tileId, await sealObject(rotation.root, workspaceId, tileId, new Uint8Array(tile.pixels), 'mask'), 'Encrypted media');
      }
      this.db.transaction(() => {
        this.db.exec({ sql: 'INSERT INTO restore_staging(id,payload,media_id) VALUES(?,?,?)', bind: [id, payload, mediaId] });
        for (const tileId of rebound.values()) this.db.exec({ sql: 'INSERT INTO mask_objects(id,image_id,staged) VALUES(?,?,1)', bind: [tileId, id] });
      });
    } else if (index >= archive.ids.length + rotation.proofIds.length) {
      const id = rotation.shareIds[index - archive.ids.length - rotation.proofIds.length]!;
      const payload = await this.sealShare(await this.readShare(id), rotation.root);
      this.db.exec({ sql: 'INSERT INTO rotation_shares(id,payload) VALUES(?,?)', bind: [id, payload] });
    } else {
      const id = rotation.proofIds[index - archive.ids.length]!;
      const row = this.db.selectObjects('SELECT payload,media_id FROM records WHERE id=?', [id])[0];
      if (!row || !(row.payload instanceof Uint8Array)) throw new Error('Workspace proof record is invalid.');
      const record = recordSchema.parse(JSON.parse(decoder.decode(await openObject(root, workspaceId, id, new Uint8Array(row.payload), 'record'))));
      if (record.mediaId !== row.media_id) throw new Error('Workspace proof media reference is invalid.');
      if (record.mediaId) {
        const file = await (await this.media.getFileHandle(`${record.mediaId}.enc`)).getFile();
        if (file.size > MAX_OBJECT_BYTES + 16384) throw new Error('Workspace proof media exceeds its size limit.');
        const media = await openObject(root, workspaceId, record.mediaId, new Uint8Array(await file.arrayBuffer()), 'media');
        record.mediaId = crypto.randomUUID();
        await this.stageMedia(record.mediaId, await sealObject(rotation.root, workspaceId, record.mediaId, media, 'media'), 'Encrypted media');
      }
      const payload = await sealObject(rotation.root, workspaceId, id, encoder.encode(JSON.stringify(record)), 'record');
      this.db.exec({ sql: 'INSERT INTO rotation_proof(id,payload,media_id) VALUES(?,?,?)', bind: [id, payload, record.mediaId] });
    }
  }
  private async finishRotation() {
    const archive = this.archive!, rotation = archive.rotation!, { workspaceId } = this.keys();
    if (this.db.selectValue('SELECT count(*) FROM restore_staging') !== archive.ids.length ||
        this.db.selectValue('SELECT count(*) FROM rotation_proof') !== rotation.proofIds.length ||
        this.db.selectValue('SELECT count(*) FROM rotation_shares') !== rotation.shareIds.length) {
      throw new Error('Workspace key rotation is incomplete. No key was changed.');
    }
    const schema = datasetSchemaSchema.parse({ ...archive.schema!, revision: archive.schema!.revision + 1 });
    const encrypted = await sealObject(rotation.root, workspaceId, workspaceId, encoder.encode(JSON.stringify(schema)), 'schema');
    this.db.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO intents(id) SELECT media_id FROM workspace_records;
        INSERT OR IGNORE INTO intents(id) SELECT media_id FROM records WHERE media_id IS NOT NULL;
        INSERT OR IGNORE INTO intents(id) SELECT media_id FROM thumbnails;
        DELETE FROM thumbnails;
        INSERT OR IGNORE INTO intents(id) SELECT id FROM mask_objects WHERE staged=0;
        DELETE FROM mask_objects WHERE staged=0;
        UPDATE workspace_records SET payload=(SELECT payload FROM restore_staging WHERE restore_staging.id=workspace_records.id),
          media_id=(SELECT media_id FROM restore_staging WHERE restore_staging.id=workspace_records.id);
        UPDATE records SET payload=(SELECT payload FROM rotation_proof WHERE rotation_proof.id=records.id),
          media_id=(SELECT media_id FROM rotation_proof WHERE rotation_proof.id=records.id);
        DELETE FROM intents WHERE id IN (SELECT media_id FROM restore_staging);
        DELETE FROM intents WHERE id IN (SELECT media_id FROM rotation_proof WHERE media_id IS NOT NULL);
        DELETE FROM intents WHERE id IN (SELECT id FROM mask_objects WHERE staged=1);
        UPDATE mask_objects SET staged=0 WHERE staged=1;
        UPDATE workspace_shares SET payload=(SELECT payload FROM rotation_shares WHERE rotation_shares.id=workspace_shares.id);
        DELETE FROM restore_staging; DELETE FROM rotation_proof; DELETE FROM rotation_shares; DELETE FROM vault_recovery;`);
      this.db.exec({ sql: 'UPDATE vault SET header=? WHERE id=1', bind: [JSON.stringify(rotation.header)] });
      this.db.exec({ sql: 'UPDATE dataset_schema SET payload=? WHERE id=1', bind: [encrypted] });
    });
    this.root = rotation.root; this.datasetSchema = schema; this.archive = undefined;
    try { await this.recover(); }
    catch { return { count: archive.count, complete: true, cleanupPending: true }; }
    return { count: archive.count, complete: true };
  }
  private async save(note: string, name: string, media: ArrayBuffer | null, interrupt: boolean): Promise<unknown> {
    const start = performance.now(), { root, workspaceId } = this.keys();
    if (this.status().ids.length >= 100) throw new Error('Proof vault limit reached (100 records). This is not a dataset store.');
    const id = crypto.randomUUID(), mediaId = media ? crypto.randomUUID() : null;
    if (media && mediaId) {
      const encrypted = await sealObject(root, workspaceId, mediaId, new Uint8Array(media), 'media');
      await this.stageMedia(mediaId, encrypted, 'Encrypted media');
      if (interrupt) throw new Error('Proof interrupted before database commit. Lock and reopen to recover the encrypted orphan.');
    }
    const payload = await sealObject(root, workspaceId, id, encoder.encode(JSON.stringify(
      recordSchema.parse({ version: 1, note, name, mediaId }),
    )), 'record');
    this.db.transaction(() => {
      this.db.exec({ sql: 'INSERT INTO records(id,payload,media_id) VALUES(?,?,?)', bind: [id, payload, mediaId] });
      if (mediaId) this.db.exec({ sql: 'DELETE FROM intents WHERE id=?', bind: [mediaId] });
    });
    return { id, milliseconds: performance.now() - start, mediaBytes: media?.byteLength ?? 0 };
  }
  private async read(id: string): Promise<unknown> {
    const { root, workspaceId } = this.keys();
    const row = this.db.selectObjects('SELECT payload,media_id FROM records WHERE id=?', [id])[0];
    if (!row || !(row.payload instanceof Uint8Array)) throw new Error('Proof record not found or invalid.');
    const record = recordSchema.parse(JSON.parse(decoder.decode(
      await openObject(root, workspaceId, id, new Uint8Array(row.payload), 'record'),
    )));
    if (record.mediaId !== row.media_id) throw new Error('Media reference authentication mismatch.');
    let media: ArrayBuffer | null = null;
    if (record.mediaId) {
      const handle = await this.media.getFileHandle(`${record.mediaId}.enc`);
      const file = await handle.getFile();
      if (file.size > 8 * 1024 * 1024 + 16_384) throw new Error('Stored media exceeds proof limits.');
      media = (await openObject(root, workspaceId, record.mediaId, new Uint8Array(await file.arrayBuffer()), 'media')).buffer;
    }
    return { note: record.note, name: record.name, media };
  }

  private async listWorkspace(offset: number, limit: number): Promise<unknown> {
    const { root, workspaceId } = this.keys();
    const total = Number(this.db.selectValue('SELECT count(*) FROM workspace_records'));
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Workspace index is invalid.');
    const rows = this.db.selectObjects(
      'SELECT id,payload FROM workspace_records ORDER BY rowid DESC LIMIT ? OFFSET ?', [limit, offset],
    );
    const items = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !(row.payload instanceof Uint8Array)) {
        throw new Error('Workspace record is invalid.');
      }
      const payload = workspaceRecordSchema.parse(JSON.parse(decoder.decode(
        await openObject(root, workspaceId, row.id, new Uint8Array(row.payload), 'record'),
      )));
      const { image, annotations, review } = payload.document;
      items.push({
        id: image.id, name: image.name, width: image.canonical.width, height: image.canonical.height,
        sourcePath: payload.sourcePath ?? image.name, split: payload.split ?? 'train',
        review, annotationCount: annotations.length,
        intakeFingerprint: payload.intakeFingerprint,
      });
    }
    return { total, items };
  }

  private async importWorkspaceImage(
    input: unknown, media: ArrayBuffer, sourcePath: string, split: 'train' | 'val' | 'test', intakeFingerprint?: string,
  ): Promise<unknown> {
    const { root, workspaceId } = this.keys();
    const supplied = documentSchema.parse(input);
    if (maskIds(supplied).length) throw new Error('Workspace mask imports require their tile payloads.');
    const schema = await this.loadDatasetSchema();
    const merged = schema ? mergeDatasetSchema(schema, supplied) : undefined;
    const bound = documentSchema.parse({
      ...supplied, image: { ...supplied.image, datasetId: workspaceId },
    });
    const document = merged ? applyDatasetSchema(bound, merged) : bound;
    const image = document.image;
    const png = new Uint8Array(media);
    const dimensions = verifySanitizedPng(png);
    if (document.revision !== 0 ||
        dimensions.width !== image.canonical.width || dimensions.height !== image.canonical.height ||
        image.mediaId === image.id) {
      throw new Error('Sanitized image and initial annotation document do not match.');
    }
    if (this.db.selectValues('SELECT id FROM workspace_records WHERE id=?', [image.id]).length > 0) {
      throw new Error('This image is already in the workspace.');
    }
    if (Number(this.db.selectValue('SELECT count(*) FROM workspace_records')) >= 10_000) {
      throw new Error('Local workspace limit reached (10,000 images).');
    }

    const start = performance.now();
    const encodedRecord = encoder.encode(JSON.stringify(
      workspaceRecordSchema.parse({ version: 1, document, mediaId: image.mediaId, sourcePath, split, intakeFingerprint }),
    ));
    if (encodedRecord.byteLength > MAX_OBJECT_BYTES) throw new Error('Annotation document exceeds the current 8 MiB record limit.');
    const payload = await sealObject(root, workspaceId, image.id, encodedRecord, 'record');
    const nextSchema = merged ? { ...merged, revision: merged.revision + 1 } : undefined;
    const schemaPayload = nextSchema ? await this.sealDatasetSchema(nextSchema) : undefined;
    const encryptedMedia = await sealObject(root, workspaceId, image.mediaId, png, 'media');
    await this.stageMedia(image.mediaId, encryptedMedia, 'Encrypted image');
    this.db.transaction(() => {
      this.db.exec({
        sql: 'INSERT INTO workspace_records(id,payload,media_id) VALUES(?,?,?)',
        bind: [image.id, payload, image.mediaId],
      });
      this.db.exec({ sql: 'DELETE FROM intents WHERE id=?', bind: [image.mediaId] });
      if (schemaPayload) this.db.exec({ sql: 'UPDATE dataset_schema SET payload=? WHERE id=1', bind: [schemaPayload] });
    });
    if (nextSchema) this.datasetSchema = nextSchema;
    return { id: image.id, revision: document.revision, milliseconds: performance.now() - start };
  }

  private async listWorkspaceExportInfo(offset: number, limit: number): Promise<unknown> {
    const { root, workspaceId } = this.keys();
    const total = Number(this.db.selectValue('SELECT count(*) FROM workspace_records'));
    if (!Number.isSafeInteger(total) || total < 0 || total > 10_000) {
      throw new Error('Workspace index is invalid.');
    }
    const rows = this.db.selectObjects(
      'SELECT id,payload FROM workspace_records ORDER BY rowid DESC LIMIT ? OFFSET ?', [limit, offset],
    );
    const items = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !(row.payload instanceof Uint8Array)) {
        throw new Error('Workspace record is invalid.');
      }
      const payload = workspaceRecordSchema.parse(JSON.parse(decoder.decode(
        await openObject(root, workspaceId, row.id, new Uint8Array(row.payload), 'record'),
      )));
      items.push({
        id: payload.document.image.id,
        document: await this.effectiveDocument(payload.document),
        sourcePath: payload.sourcePath ?? payload.document.image.name,
        split: payload.split ?? 'train',
      });
    }
    return { total, items };
  }

  private async readWorkspaceImage(id: string) {
    const { root, workspaceId } = this.keys();
    const payload = await this.readWorkspaceRecord(id);
    const handle = await this.media.getFileHandle(`${payload.mediaId}.enc`);
    const file = await handle.getFile();
    if (file.size > 8 * 1024 * 1024 + 16_384) throw new Error('Stored image exceeds the current workspace limit.');
    const media = await openObject(root, workspaceId, payload.mediaId, new Uint8Array(await file.arrayBuffer()), 'media');
    const dimensions = verifySanitizedPng(media);
    if (dimensions.width !== payload.document.image.canonical.width ||
        dimensions.height !== payload.document.image.canonical.height) {
      throw new Error('Stored image dimensions do not match the annotation document.');
    }
    return {
      document: await this.effectiveDocument(payload.document), media: media.buffer,
      sourcePath: payload.sourcePath ?? payload.document.image.name, split: payload.split ?? 'train',
      intakeFingerprint: payload.intakeFingerprint,
    };
  }

  private async readThumbnail(id: string) {
    const { root, workspaceId } = this.keys();
    const stored = this.db.selectValue('SELECT media_id FROM thumbnails WHERE image_id=?', [id]);
    if (stored !== undefined) {
      const mediaId = z.uuid().parse(stored);
      const file = await (await this.media.getFileHandle(`${mediaId}.enc`)).getFile();
      if (file.size > 128 * 1024 + 16_384) throw new Error('Stored media thumbnail exceeds its size limit.');
      const media = await openObject(root, workspaceId, mediaId, new Uint8Array(await file.arrayBuffer()), 'thumbnail');
      const dimensions = verifySanitizedPng(media);
      if (media.byteLength > 128 * 1024 || dimensions.width > 160 || dimensions.height > 160) {
        throw new Error('Stored media thumbnail is invalid.');
      }
      return { media: media.buffer };
    }
    const image = await this.readWorkspaceImage(id);
    const bitmap = await createImageBitmap(new Blob([image.media], { type: 'image/png' }));
    let media: Uint8Array<ArrayBuffer>;
    try {
      const ratio = Math.min(1, 160 / bitmap.width, 160 / bitmap.height);
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!context) throw new Error('Workspace thumbnail rendering is unavailable.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      media = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      verifySanitizedPng(media);
      if (media.byteLength > 128 * 1024) throw new Error('Workspace thumbnail exceeds its size limit.');
    } finally { bitmap.close(); }
    const mediaId = crypto.randomUUID();
    await this.stageMedia(mediaId, await sealObject(root, workspaceId, mediaId, media, 'thumbnail'), 'Encrypted media');
    this.db.transaction(() => {
      this.db.exec({ sql: 'INSERT INTO thumbnails(image_id,media_id) VALUES(?,?)', bind: [id, mediaId] });
      this.db.exec({ sql: 'DELETE FROM intents WHERE id=?', bind: [mediaId] });
    });
    return { media: media.buffer };
  }

  private async updateWorkspaceImage(id: string, expectedRevision: number, input: unknown, tiles: MaskTile[] = []): Promise<unknown> {
    const { root, workspaceId } = this.keys();
    const document = documentSchema.parse(input);
    const schema = await this.loadDatasetSchema();
    if (schema && (JSON.stringify(document.classes) !== JSON.stringify(schema.classes) ||
        JSON.stringify(document.skeletons) !== JSON.stringify(schema.skeletons))) {
      throw new Error('Workspace schema changed; reopen the image before saving. Schema changes use dataset-wide controls.');
    }
    if (document.image.id !== id || document.revision !== expectedRevision + 1) {
      throw new Error('Workspace update has a stale revision or mismatched image.');
    }
    const row = this.db.selectObjects('SELECT payload,media_id FROM workspace_records WHERE id=?', [id])[0];
    if (!row || !(row.payload instanceof Uint8Array) || typeof row.media_id !== 'string') {
      throw new Error('Workspace image not found.');
    }
    const previous = workspaceRecordSchema.parse(JSON.parse(decoder.decode(
      await openObject(root, workspaceId, id, new Uint8Array(row.payload), 'record'),
    )));
    if (previous.document.revision !== expectedRevision ||
        JSON.stringify(previous.document.image) !== JSON.stringify(document.image) ||
        previous.mediaId !== row.media_id) {
      throw new Error('Workspace image changed; reload before saving.');
    }

    const encodedRecord = encoder.encode(JSON.stringify(
      workspaceRecordSchema.parse({
        version: 1, document, mediaId: previous.mediaId,
        sourcePath: previous.sourcePath ?? previous.document.image.name,
        split: previous.split ?? 'train',
        intakeFingerprint: previous.intakeFingerprint,
      }),
    ));
    if (encodedRecord.byteLength > MAX_OBJECT_BYTES) throw new Error('Annotation document exceeds the current 8 MiB record limit.');
    const payload = await sealObject(root, workspaceId, id, encodedRecord, 'record');
    await this.prepareMaskTiles(id, document, tiles);
    this.db.transaction(() => {
      this.db.exec({ sql: 'UPDATE workspace_records SET payload=? WHERE id=?', bind: [payload, id] });
      for (const tile of tiles) {
        this.db.exec({ sql: 'INSERT INTO mask_objects(id,image_id,staged) VALUES(?,?,0)', bind: [tile.id, id] });
        this.db.exec({ sql: 'DELETE FROM intents WHERE id=?', bind: [tile.id] });
      }
    });
    return { id, revision: document.revision };
  }

  private async deleteWorkspaceImage(id: string): Promise<unknown> {
    this.keys();
    const row = this.db.selectObjects('SELECT media_id FROM workspace_records WHERE id=?', [id])[0];
    if (!row || typeof row.media_id !== 'string') throw new Error('Workspace image not found.');
    const mediaId = z.uuid().parse(row.media_id);
    this.db.transaction(() => {
      this.db.exec({ sql: 'INSERT INTO intents(id) VALUES(?)', bind: [mediaId] });
      this.db.exec({ sql: 'DELETE FROM workspace_records WHERE id=?', bind: [id] });
      this.db.exec({ sql: 'INSERT INTO intents(id) SELECT id FROM mask_objects WHERE image_id=?', bind: [id] });
      this.db.exec({ sql: 'DELETE FROM mask_objects WHERE image_id=?', bind: [id] });
      this.db.exec({ sql: 'INSERT INTO intents(id) SELECT media_id FROM thumbnails WHERE image_id=?', bind: [id] });
      this.db.exec({ sql: 'DELETE FROM thumbnails WHERE image_id=?', bind: [id] });
    });
    try { await this.media.removeEntry(`${mediaId}.enc`); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        throw new Error('Image was removed from the workspace, but encrypted-file cleanup failed. Reopen to recover.');
      }
    }
    this.db.exec({ sql: 'DELETE FROM intents WHERE id=?', bind: [mediaId] });
    await this.recover();
    return { deleted: true };
  }
}
