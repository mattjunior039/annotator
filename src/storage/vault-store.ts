import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { z } from 'zod';
import { changeVaultPassphrase, createDeviceKey, createVaultKey, deviceKeySchema, MAX_OBJECT_BYTES, openDeviceKey, openObject, sealObject, unlockVaultKey, wrappedKeySchema } from '../crypto/vault';
import { verifySanitizedPng } from '../datasets/media';
import { documentSchema } from '../domain/model';
import type { StorageRequest, VaultStatus, WorkspaceDescriptor } from '../workers/protocol';
import { workspaceCatalogSchema, workspaceDescriptorSchema, workspaceIdSchema } from '../workers/protocol';
import { BackupReader, BackupWriter, restoredDocument } from './backup';
import { applyDatasetSchema, datasetSchemaSchema, emptyDatasetSchema, extendDatasetSchema, mergeDatasetSchema } from '../domain/dataset-schema';
import type { DatasetSchema } from '../domain/dataset-schema';
import type { AnnotationDocument } from '../domain/model';

const recordSchema = z.strictObject({
  version: z.literal(1), note: z.string().max(4096), name: z.string().min(1).max(256),
  mediaId: z.uuid().nullable(),
});
const workspaceRecordSchema = z.strictObject({
  version: z.literal(1), document: documentSchema, mediaId: z.uuid(),
  sourcePath: z.string().min(1).max(1024).optional(),
  split: z.enum(['train', 'val', 'test']).optional(),
});
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
let sqliteModule: ReturnType<typeof sqlite3InitModule> | undefined;

export class VaultStore {
  private root: CryptoKey | undefined;
  private workspaceId: string | undefined;
  private recovered = 0;
  private datasetSchema: DatasetSchema | undefined;
  private schemaScan: { ids: string[]; index: number; schema: DatasetSchema } | undefined;
  private archive: {
    session: string; index: number; count: number;
    writer?: BackupWriter; reader?: BackupReader; ids: string[]; schema?: DatasetSchema;
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
      if (![0, 1, 2, 3, 4, 5].includes(Number(version))) throw new Error('Unsupported proof database version. Data was not changed.');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id=1), header TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, payload BLOB NOT NULL, media_id TEXT);
        CREATE TABLE IF NOT EXISTS workspace_records (id TEXT PRIMARY KEY, payload BLOB NOT NULL, media_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS restore_staging (id TEXT PRIMARY KEY, payload BLOB NOT NULL, media_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL, password_protected INTEGER NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS dataset_schema (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL);
        PRAGMA user_version=5;
        COMMIT;`);
      const opfs = await navigator.storage.getDirectory();
      const media = await opfs.getDirectoryHandle(legacy ? 'annotator-phase1-media' : `annotator-${scope}-media`, { create: true });
      const store = new VaultStore(db, media, sqlite.version.libVersion, () => pool.pauseVfs());
      await store.recover();
      return store;
    } catch (error) { db.close(); pool.pauseVfs(); throw error; }
  }
  close(): void { this.root = undefined; this.datasetSchema = undefined; this.schemaScan = undefined; this.db.close(); this.releaseHandles(); }
  static async openSelected(id: string): Promise<VaultStore> {
    workspaceIdSchema.parse(id);
    const descriptor = (await VaultStore.handleCatalog({ type: 'catalog-list' })).find(item => item.id === id);
    if (!descriptor) throw new Error('Workspace no longer exists in the local catalog.');
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
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-list' | 'catalog-create' }>): Promise<WorkspaceDescriptor[] | WorkspaceDescriptor>;
  static async handleCatalog(request: Extract<StorageRequest, { type: 'catalog-list' | 'catalog-create' }>): Promise<WorkspaceDescriptor[] | WorkspaceDescriptor> {
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
    for (const row of this.db.selectObjects('SELECT id FROM intents')) {
      const id = z.uuid().parse(row.id);
      const referenced = this.db.selectValue(
        'SELECT (SELECT count(*) FROM records WHERE media_id=?) + (SELECT count(*) FROM workspace_records WHERE media_id=?)',
        [id, id],
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
    if (this.schemaScan && !['schema-open', 'schema-step', 'schema-finish', 'status'].includes(request.type)) {
      throw new Error('Workspace schema migration is in progress. Finish it or reopen the workspace before making changes.');
    }
    if (this.archive && !['status', 'archive-step', 'archive-finish', 'archive-cancel'].includes(request.type)) {
      throw new Error('Workspace backup or restore is in progress. Finish or cancel it before making other changes.');
    }
    switch (request.type) {
      case 'catalog-list':
      case 'catalog-create': throw new Error('Workspace must be exited before changing the workspace catalog.');
      case 'workspace-open': return this.status();
      case 'schema-open': {
        this.keys();
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
        request.document, request.media, request.sourcePath, request.split,
      );
      case 'workspace-read': return this.readWorkspaceImage(request.id);
      case 'workspace-update': return this.updateWorkspaceImage(request.id, request.expectedRevision, request.document);
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
  private getArchive(session: string) {
    if (!this.archive || this.archive.session !== session) throw new Error('Workspace backup or restore session is no longer active.');
    return this.archive;
  }
  private async stageMedia(
    mediaId: string, encrypted: Uint8Array<ArrayBuffer>,
    description: 'Encrypted media' | 'Encrypted image' | 'Workspace restore media',
  ): Promise<void> {
    const referenced = this.db.selectValue(
      'SELECT (SELECT count(*) FROM records WHERE media_id=?) + (SELECT count(*) FROM workspace_records WHERE media_id=?) + (SELECT count(*) FROM restore_staging WHERE media_id=?)',
      [mediaId, mediaId, mediaId],
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
    if (archive.writer) {
      const image = await this.readWorkspaceImage(archive.ids[index]!);
      await archive.writer.append({
        document: image.document, sourcePath: image.sourcePath, split: image.split,
      }, new Uint8Array(image.media));
    } else if (archive.reader) {
      const { record, media } = await archive.reader.read(index);
      archive.schema = mergeDatasetSchema(archive.schema ?? emptyDatasetSchema(), record.document);
      const { root, workspaceId } = this.keys();
      const document = restoredDocument(record.document, workspaceId);
      const id = document.image.id, mediaId = document.image.mediaId;
      const payload = await sealObject(root, workspaceId, id, encoder.encode(JSON.stringify(
        workspaceRecordSchema.parse({ version: 1, document, mediaId, sourcePath: record.sourcePath, split: record.split }),
      )), 'record');
      const encrypted = await sealObject(root, workspaceId, mediaId, media, 'media');
      await this.stageMedia(mediaId, encrypted, 'Workspace restore media');
      this.db.exec({
        sql: 'INSERT INTO restore_staging(id,payload,media_id) VALUES(?,?,?)',
        bind: [id, payload, mediaId],
      });
    } else throw new Error('Workspace archive session is invalid.');
    archive.index++;
    return { session, count: archive.count, completed: archive.index };
  }
  private async archiveFinish(session: string) {
    const archive = this.getArchive(session);
    if (archive.index !== archive.count) throw new Error('Workspace archive is incomplete; no restore was committed.');
    if (archive.writer) await archive.writer.finish();
    if (archive.reader) {
      const merged = archive.schema ?? emptyDatasetSchema();
      const schema = { ...merged, revision: merged.revision + 1 };
      const encryptedSchema = await this.sealDatasetSchema(schema);
      if (this.db.selectValue('SELECT count(*) FROM workspace_records') !== 0 ||
          this.db.selectValue('SELECT count(*) FROM restore_staging') !== archive.count) {
        throw new Error('Workspace changed during restore. No staged images were committed.');
      }
      this.db.transaction(() => {
        this.db.exec('INSERT INTO workspace_records(id,payload,media_id) SELECT id,payload,media_id FROM restore_staging ORDER BY rowid DESC');
        this.db.exec('DELETE FROM intents WHERE id IN (SELECT media_id FROM restore_staging)');
        this.db.exec('DELETE FROM restore_staging');
        this.db.exec({ sql: 'INSERT OR REPLACE INTO dataset_schema(id,payload) VALUES(1,?)', bind: [encryptedSchema] });
      });
      this.datasetSchema = schema;
    }
    this.archive = undefined;
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
      });
    }
    return { total, items };
  }

  private async importWorkspaceImage(
    input: unknown, media: ArrayBuffer, sourcePath: string, split: 'train' | 'val' | 'test',
  ): Promise<unknown> {
    const { root, workspaceId } = this.keys();
    const supplied = documentSchema.parse(input);
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
      workspaceRecordSchema.parse({ version: 1, document, mediaId: image.mediaId, sourcePath, split }),
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
    };
  }

  private async updateWorkspaceImage(id: string, expectedRevision: number, input: unknown): Promise<unknown> {
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
      }),
    ));
    if (encodedRecord.byteLength > MAX_OBJECT_BYTES) throw new Error('Annotation document exceeds the current 8 MiB record limit.');
    const payload = await sealObject(root, workspaceId, id, encodedRecord, 'record');
    this.db.exec({ sql: 'UPDATE workspace_records SET payload=? WHERE id=?', bind: [payload, id] });
    return { id, revision: document.revision };
  }

  private async deleteWorkspaceImage(id: string): Promise<unknown> {
    const row = this.db.selectObjects('SELECT media_id FROM workspace_records WHERE id=?', [id])[0];
    if (!row || typeof row.media_id !== 'string') throw new Error('Workspace image not found.');
    const mediaId = z.uuid().parse(row.media_id);
    this.db.transaction(() => {
      this.db.exec({ sql: 'INSERT INTO intents(id) VALUES(?)', bind: [mediaId] });
      this.db.exec({ sql: 'DELETE FROM workspace_records WHERE id=?', bind: [id] });
    });
    try { await this.media.removeEntry(`${mediaId}.enc`); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        throw new Error('Image was removed from the workspace, but encrypted-file cleanup failed. Reopen to recover.');
      }
    }
    this.db.exec({ sql: 'DELETE FROM intents WHERE id=?', bind: [mediaId] });
    return { deleted: true };
  }
}
