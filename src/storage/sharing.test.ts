import { describe, expect, it, vi } from 'vitest';
import { openObject, sealObject } from '../crypto/vault';
import { toBase64Url } from '../collaboration/encoding';
import { documentSchema } from '../domain/model';
import { encryptProposal } from '../sharing/proposal';
import { proposalPreviewSchema, shareReceiptSchema } from '../sharing/model';
import type { ShareReceipt } from '../sharing/model';
import { VaultStore } from './vault-store';

vi.mock('@sqlite.org/sqlite-wasm', () => ({ default: vi.fn() }));
type Row = { payload: Uint8Array<ArrayBuffer>; media_id: string };
class ShareDatabase {
  records = new Map<string, Row>();
  shares = new Map<string, Uint8Array<ArrayBuffer>>();
  failCommit = false;
  selectValue(sql: string, bind: string[]) {
    if (sql === 'SELECT payload FROM workspace_shares WHERE id=?') return this.shares.get(bind[0]!);
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  selectObjects(sql: string, bind: string[]) {
    if (sql === 'SELECT payload,media_id FROM workspace_records WHERE id=?') {
      const row = this.records.get(bind[0]!); return row ? [row] : [];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  exec({ sql, bind }: { sql: string; bind: unknown[] }) {
    if (sql === 'UPDATE workspace_records SET payload=? WHERE id=?') {
      const id = bind[1] as string;
      this.records.set(id, { ...this.records.get(id)!, payload: bind[0] as Uint8Array<ArrayBuffer> });
    } else if (sql === 'UPDATE workspace_shares SET payload=? WHERE id=?') {
      if (this.failCommit) throw new Error('Injected approval publication failure');
      this.shares.set(bind[1] as string, bind[0] as Uint8Array<ArrayBuffer>);
    } else throw new Error(`Unexpected SQL: ${sql}`);
  }
  transaction(action: () => void) {
    const records = new Map(this.records), shares = new Map(this.shares);
    try { action(); } catch (error) { this.records = records; this.shares = shares; throw error; }
  }
}

async function fixture() {
  const root = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'HKDF', false, ['deriveKey']);
  const workspaceId = crypto.randomUUID(), shareId = crypto.randomUUID(), classId = crypto.randomUUID();
  const db = new ShareDatabase(), encoder = new TextEncoder();
  const documents = Array.from({ length: 2 }, (_, index) => documentSchema.parse({
    version: 1, revision: 0, review: 'unannotated',
    image: { version: 1, id: crypto.randomUUID(), datasetId: workspaceId, mediaId: crypto.randomUUID(),
      name: `approval-private-${index}.png`, source: { width: 30, height: 20 }, canonical: { width: 30, height: 20 }, orientation: 1 },
    classes: [{ id: classId, name: 'Object', color: '#39764d', exclusiveGroup: null }],
    skeletons: [], annotations: [],
  }));
  const schema = { version: 1, revision: 0, classes: documents[0]!.classes, skeletons: [] };
  const changes = documents.map(base => {
    const next = structuredClone(base);
    next.annotations.push({ id: crypto.randomUUID(), kind: 'box', classId, attributes: {}, x: 1, y: 2, width: 4, height: 5 });
    next.revision++;
    return { base, next };
  });
  const receipt: ShareReceipt = {
    invitation: { version: 1, id: shareId, key: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      download: 'https://s3.example/snapshot', upload: 'https://s3.example/proposal', expires: new Date(Date.now() + 86_400_000).toISOString() },
    role: 'owner', name: 'Riley', reviewUrl: 'https://s3.example/proposal', status: 'open', bases: documents,
  };
  db.shares.set(shareId, await sealObject(root, workspaceId, shareId, encoder.encode(JSON.stringify(receipt)), 'record'));
  async function saveDocument(document: typeof documents[number]) {
    db.records.set(document.image.id, { media_id: document.image.mediaId,
      payload: await sealObject(root, workspaceId, document.image.id, encoder.encode(JSON.stringify({
        version: 1, document, mediaId: document.image.mediaId, sourcePath: document.image.name, split: 'train',
      })), 'record'),
    });
  }
  for (const document of documents) await saveDocument(document);
  const makeStore = () => {
    const store = Reflect.construct(VaultStore, [db, {}, '', () => {}]) as VaultStore;
    Object.assign(store, { root, workspaceId, datasetSchema: schema });
    return store;
  };
  const proposal = { version: 1 as const, shareId, author: 'Riley', message: 'Please approve these boxes', changes };
  const store = makeStore();
  const preview = async () => proposalPreviewSchema.parse(await store.handle({
    type: 'share-review', id: shareId, media: await encryptProposal(receipt.invitation, proposal),
  }));
  const read = async (id: string) => JSON.parse(new TextDecoder().decode(await openObject(root, workspaceId, id, db.records.get(id)!.payload, 'record')));
  const readReceipt = async () => shareReceiptSchema.parse(JSON.parse(new TextDecoder().decode(await openObject(root, workspaceId, shareId, db.shares.get(shareId)!, 'record'))));
  return { db, store, proposal, documents, preview, read, readReceipt, saveDocument, makeStore, receipt };
}

describe('encrypted proposal approvals', () => {
  it('publishes every image and its decision atomically; publication failure rolls back all ciphertext', async () => {
    const { db, store, documents, preview, read, readReceipt } = await fixture();
    const plan = await preview(), originals = new Map(db.records), shares = new Map(db.shares);
    db.failCommit = true;
    await expect(store.handle({ type: 'share-decide', token: plan.token, approve: true })).rejects.toThrow('Injected');
    expect(db.records).toEqual(originals); expect(db.shares).toEqual(shares);
    db.failCommit = false;
    await expect(store.handle({ type: 'share-decide', token: plan.token, approve: true })).resolves.toMatchObject({ count: 2, complete: true });
    for (const document of documents) {
      expect((await read(document.image.id)).document).toMatchObject({ revision: 1, annotations: [{ kind: 'box' }] });
      expect(new TextDecoder().decode(db.records.get(document.image.id)!.payload)).not.toContain('approval-private');
    }
    expect((await readReceipt()).status).toBe('approved');
    await expect(store.handle({ type: 'share-decide', token: plan.token, approve: true })).rejects.toThrow('stale');
  });
  it('rejects forged bases, duplicated images, and replay after reopening the workspace', async () => {
    const { store, proposal, receipt, preview, makeStore } = await fixture();
    proposal.changes[0]!.base.review = 'reviewed';
    await expect(preview()).rejects.toThrow('original shared snapshot');
    proposal.changes[0]!.base.review = 'unannotated';
    proposal.changes.push(proposal.changes[0]!);
    await expect(preview()).rejects.toThrow('original shared snapshot');
    proposal.changes.pop();
    const plan = await preview();
    await store.handle({ type: 'share-decide', token: plan.token, approve: true });
    await expect(makeStore().handle({ type: 'share-review', id: receipt.invitation.id,
      media: await encryptProposal(receipt.invitation, proposal) })).rejects.toThrow('already been reviewed');
  });
  it('rechecks revisions at approval and never partially merges a now-conflicting proposal', async () => {
    const { store, documents, proposal, preview, saveDocument, db } = await fixture();
    const plan = await preview();
    const owner = structuredClone(documents[1]!);
    owner.annotations = [{ ...proposal.changes[1]!.next.annotations[0]!, attributes: { owner: true } }];
    owner.revision = 1;
    await saveDocument(owner);
    const before = new Map(db.records);
    await expect(store.handle({ type: 'share-decide', token: plan.token, approve: true })).rejects.toThrow('conflicts');
    expect(db.records).toEqual(before);
    const updated = await preview();
    expect(updated.conflicts).toHaveLength(1);
    await store.handle({ type: 'share-decide', token: updated.token, approve: false });
    expect(db.records).toEqual(before);
  });
});
