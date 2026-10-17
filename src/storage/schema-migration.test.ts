import { describe, expect, it, vi } from 'vitest';
import { openObject, sealObject } from '../crypto/vault';
import { emptyDatasetSchema, mergeDatasetSchema } from '../domain/dataset-schema';
import { documentSchema } from '../domain/model';
import { schemaMigrationPreviewSchema, schemaProgressSchema } from '../workers/protocol';
import { VaultStore } from './vault-store';

vi.mock('@sqlite.org/sqlite-wasm', () => ({ default: vi.fn() }));

type Row = { payload: Uint8Array<ArrayBuffer>; media_id: string };
class MigrationDatabase {
  records = new Map<string, Row>();
  staged = new Map<string, Row>();
  schema!: Uint8Array<ArrayBuffer>;
  failStage = false;
  failPublish = false;
  stagedCiphertexts: Uint8Array[] = [];
  selectValue(sql: string) {
    if (sql === 'SELECT payload FROM dataset_schema WHERE id=1') return this.schema;
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  selectValues(sql: string) {
    if (sql === 'SELECT id FROM workspace_records ORDER BY rowid') return [...this.records.keys()];
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  selectObjects(sql: string, bind: string[]) {
    if (sql === 'SELECT payload,media_id FROM workspace_records WHERE id=?') {
      const row = this.records.get(bind[0]!);
      return row ? [row] : [];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  exec(input: string | { sql: string; bind: unknown[] }) {
    const sql = typeof input === 'string' ? input : input.sql;
    const bind = typeof input === 'string' ? [] : input.bind;
    switch (sql) {
      case 'DELETE FROM restore_staging': this.staged.clear(); break;
      case 'INSERT INTO restore_staging(id,payload,media_id) VALUES(?,?,?)': {
        if (this.failStage && this.staged.size === 1) throw new Error('Injected staging failure');
        const payload = bind[1] as Uint8Array<ArrayBuffer>;
        this.staged.set(bind[0] as string, { payload, media_id: bind[2] as string });
        this.stagedCiphertexts.push(payload);
        break;
      }
      case 'UPDATE workspace_records SET payload=(SELECT payload FROM restore_staging WHERE restore_staging.id=workspace_records.id)':
        for (const [id, row] of this.staged) this.records.set(id, row);
        break;
      case 'UPDATE dataset_schema SET payload=? WHERE id=1':
        if (this.failPublish) throw new Error('Injected publication failure');
        this.schema = bind[0] as Uint8Array<ArrayBuffer>;
        break;
      default: throw new Error(`Unexpected SQL: ${sql}`);
    }
  }
  transaction(action: () => void) {
    const records = new Map(this.records), staged = new Map(this.staged), schema = this.schema;
    try { action(); }
    catch (failure) { this.records = records; this.staged = staged; this.schema = schema; throw failure; }
  }
}

async function fixture() {
  const workspaceId = crypto.randomUUID();
  const root = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'HKDF', false, ['deriveKey']);
  const db = new MigrationDatabase();
  const documents = Array.from({ length: 2 }, (_, index) => {
    const classId = crypto.randomUUID(), skeletonId = crypto.randomUUID();
    return documentSchema.parse({
      version: 1, revision: index + 3, review: 'reviewed',
      image: {
        version: 1, id: crypto.randomUUID(), datasetId: workspaceId, mediaId: crypto.randomUUID(),
        name: `migration-canary-${index}.png`, source: { width: 30, height: 20 }, canonical: { width: 30, height: 20 }, orientation: 1,
      },
      classes: [{ id: classId, name: 'Object', color: '#39764d', exclusiveGroup: null }],
      skeletons: [{ id: skeletonId, name: 'Point', points: index ? ['Tip', 'Point'] : ['Point', 'Tip'], edges: [] }],
      annotations: [{
        id: crypto.randomUUID(), kind: 'keypoints', classId, skeletonId, attributes: {},
        points: [{ x: 3, y: 4, visibility: 'visible' }, { x: 7, y: 8, visibility: 'occluded' }],
      }],
    });
  });
  const before = documents.reduce((schema, document) => mergeDatasetSchema(schema, document), emptyDatasetSchema());
  const next = structuredClone(before);
  next.revision++; next.skeletons[0]!.points = ['Tip'];
  const encoder = new TextEncoder();
  db.schema = await sealObject(root, workspaceId, workspaceId, encoder.encode(JSON.stringify(before)), 'schema');
  for (const document of documents) db.records.set(document.image.id, {
    payload: await sealObject(root, workspaceId, document.image.id, encoder.encode(JSON.stringify({
      version: 1, document, mediaId: document.image.mediaId, sourcePath: `train/${document.image.name}`, split: 'train',
    })), 'record'),
    media_id: document.image.mediaId,
  });
  const store = Reflect.construct(VaultStore, [db, {}, '', () => {}]) as VaultStore;
  Object.assign(store, { root, workspaceId });
  const preview = async () => schemaMigrationPreviewSchema.parse(await store.handle({
    type: 'schema-preview', expectedRevision: before.revision, schema: next, remaps: [],
  }));
  return { store, db, before, documents, preview, root, workspaceId };
}

describe('atomic encrypted dataset migrations', () => {
  for (const fault of ['failStage', 'failPublish'] as const) it(`publishes nothing and cleans ciphertext staging on ${fault}`, async () => {
    const { store, db, preview } = await fixture();
    const original = new Map(db.records), schema = db.schema.slice();
    const plan = await preview();
    db[fault] = true;
    await expect(store.handle({ type: 'schema-apply', token: plan.token, confirmDiscard: true })).rejects.toThrow('Injected');
    expect(db.records).toEqual(original);
    expect(db.schema).toEqual(schema);
    expect(db.staged.size).toBe(0);
    expect(db.stagedCiphertexts.length).toBeGreaterThan(0);
    for (const bytes of db.stagedCiphertexts) {
      expect(new TextDecoder().decode(bytes)).not.toContain('migration-canary');
      expect(new TextDecoder().decode(bytes)).not.toContain('"annotations"');
    }
    await expect(store.handle({ type: 'schema-apply', token: plan.token, confirmDiscard: true })).rejects.toThrow('stale');
  });
  it('commits schema and every legacy document together, preserving named coordinates and metadata', async () => {
    const { store, db, preview, documents, root, workspaceId } = await fixture();
    const plan = await preview();
    expect(plan).toMatchObject({ discardedCoordinates: 2, affectedAnnotations: 2 });
    const result = schemaProgressSchema.parse(await store.handle({ type: 'schema-apply', token: plan.token, confirmDiscard: true }));
    expect(result).toMatchObject({ completed: 2, total: 2 });
    const persistedSchema = JSON.parse(new TextDecoder().decode(await openObject(root, workspaceId, workspaceId, db.schema, 'schema')));
    expect(persistedSchema).toEqual(result.schema);
    for (const [index, original] of documents.entries()) {
      const record = JSON.parse(new TextDecoder().decode(await openObject(root, workspaceId, original.image.id, db.records.get(original.image.id)!.payload, 'record')));
      expect(record.document).toMatchObject({
        revision: original.revision + 1, review: original.review, image: original.image,
        classes: result.schema.classes, skeletons: result.schema.skeletons,
      });
      expect(record.document.annotations).toHaveLength(1);
      expect(record.document.annotations[0].points).toEqual(index
        ? [{ x: 3, y: 4, visibility: 'visible' }]
        : [{ x: 7, y: 8, visibility: 'occluded' }]);
      expect(record.sourcePath).toBe(`train/${original.image.name}`);
      expect(record.mediaId).toBe(original.image.mediaId);
    }
    expect(db.staged.size).toBe(0);
  });
  it('keeps data unchanged without coordinate confirmation and rejects a preview invalidated by another operation', async () => {
    const { store, db, preview, before } = await fixture();
    const original = new Map(db.records), schema = db.schema.slice();
    const plan = await preview();
    await expect(store.handle({ type: 'schema-apply', token: plan.token, confirmDiscard: false })).rejects.toThrow('confirmation');
    expect(db.records).toEqual(original);
    await store.handle({ type: 'schema-update', expectedRevision: before.revision, schema: { ...before, revision: before.revision + 1 } });
    await expect(store.handle({ type: 'schema-apply', token: plan.token, confirmDiscard: true })).rejects.toThrow('stale');
    expect(db.records).toEqual(original);
    expect(db.schema).not.toEqual(schema);
  });
});
