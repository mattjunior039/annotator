import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Bridge } from './bridge.ts';
import { DATA_TTL, PAIR_TTL, SESSION_TTL, snapshotSchema } from './protocol.ts';
import type { Scope } from './protocol.ts';

export const origin = 'http://127.0.0.1:5173';
export function fixture() {
  const workspaceId = randomUUID(), imageId = randomUUID(), classId = randomUUID();
  const snapshot = {
    revision: 1, classes: [classId], images: [{ id: imageId, width: 100, height: 80 }],
    annotations: [{ id: randomUUID(), imageId, classId, box: [1, 2, 30, 40] as [number, number, number, number],
      review: 'unreviewed' as const }],
  };
  let time = 1000;
  const bridge = new Bridge([origin], () => time);
  const pair = (permissions: Scope[] = ['metadata', 'counts', 'propose']) => {
    const request = bridge.beginPair({ origin, workspaceId, scopes: permissions });
    const approval = { type: 'pair', token: request.token, workspaceId, approved: true, scopes: permissions };
    const { bearer } = bridge.pair(origin, approval);
    return { bearer, approval };
  };
  const publish = (bearer: string, value: unknown = snapshot) =>
    bridge.browser(origin, bearer, { type: 'snapshot', snapshot: value });
  const patch = { baseRevision: 1, operations: [{ type: 'replace-box', annotation: {
    ...snapshot.annotations[0]!, box: [5, 6, 20, 30],
  } }] };
  return { bridge, workspaceId, snapshot, pair, publish, patch, advance: (ms: number) => { time += ms; } };
}

describe('bounded authorization and disclosure', () => {
  it('requires approval, exact origin/workspace, non-replayable pairing and an independent bearer', () => {
    const f = fixture();
    const pending = f.bridge.beginPair({ origin, workspaceId: f.workspaceId, scopes: ['counts'] });
    const approval = { type: 'pair', token: pending.token, workspaceId: f.workspaceId, approved: true, scopes: ['counts'] };
    expect(() => f.bridge.pair('https://attacker.example', approval)).toThrow('denied');
    expect(() => f.bridge.pair(origin, { ...approval, workspaceId: randomUUID() })).toThrow('denied');
    expect(() => f.bridge.pair(origin, { ...approval, approved: false })).toThrow('denied');
    const { bearer } = f.bridge.pair(origin, approval);
    expect(bearer).not.toBe(pending.token);
    expect(() => f.bridge.pair(origin, approval)).toThrow('denied');
    expect(() => f.bridge.authenticate(origin, pending.token)).toThrow('denied');
    expect(() => f.bridge.authenticate('https://attacker.example', bearer)).toThrow('denied');
  });

  it('expires pairing, bounds attempts, and prevents scope escalation', () => {
    const f = fixture();
    const pending = f.bridge.beginPair({ origin, workspaceId: f.workspaceId, scopes: ['counts'] });
    f.advance(PAIR_TTL);
    expect(() => f.bridge.pair(origin, { type: 'pair', token: pending.token,
      workspaceId: f.workspaceId, approved: true, scopes: ['counts'] })).toThrow('denied');
    const next = f.bridge.beginPair({ origin, workspaceId: f.workspaceId, scopes: ['counts'] });
    const approval = { type: 'pair', token: next.token, workspaceId: f.workspaceId, approved: true, scopes: ['metadata'] };
    expect(() => f.bridge.pair(origin, approval)).toThrow('denied');
    expect(() => f.bridge.pair(origin, { ...approval, scopes: ['counts'] })).toThrow('denied');
    for (let i = 0; i < 4; i++) f.bridge.beginPair({ origin, workspaceId: f.workspaceId, scopes: ['counts'] });
    expect(() => f.bridge.beginPair({ origin, workspaceId: f.workspaceId, scopes: ['counts'] })).toThrow('limited');
  });

  it('distinguishes authorization, browser data leases and actual file visibility', () => {
    const f = fixture(), { bearer } = f.pair(['counts']);
    expect(f.bridge.status()).toMatchObject({ authorized: true, approvedDataAvailable: false, fileVisibility: 'not-observed' });
    expect(() => f.bridge.counts()).toThrow('stale');
    f.publish(bearer);
    expect(f.bridge.counts()).toMatchObject({ images: 1, annotations: 1 });
    expect(() => f.bridge.metadata()).toThrow('denied');
    expect(() => f.bridge.propose(f.patch)).toThrow('denied');
    f.advance(DATA_TTL);
    expect(() => f.bridge.counts()).toThrow('stale');
    expect(f.bridge.status()).toMatchObject({ authorized: true, approvedDataAvailable: false });
    f.advance(SESSION_TTL);
    expect(() => f.bridge.authenticate(origin, bearer)).toThrow('denied');
  });

  it.each(['filename', 'path', 'key', 'gps', 'pixels', 'thumbnail', 'attributes', 'label', 'mask'])(
    'rejects unauthorized %s at every data boundary', field => {
      const f = fixture(), { bearer } = f.pair();
      for (const snapshot of [
        { ...f.snapshot, [field]: 'SENSITIVE' },
        { ...f.snapshot, images: [{ ...f.snapshot.images[0], [field]: 'SENSITIVE' }] },
        { ...f.snapshot, annotations: [{ ...f.snapshot.annotations[0], [field]: 'SENSITIVE' }] },
      ]) {
        expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
        expect(() => f.publish(bearer, snapshot)).toThrow('invalid');
      }
      f.publish(bearer);
      expect(JSON.stringify(f.bridge.metadata())).not.toContain('SENSITIVE');
    },
  );

  it('rejects nonopaque IDs, missing references, duplicate IDs and out-of-bounds boxes', () => {
    const f = fixture();
    for (const snapshot of [
      { ...f.snapshot, classes: ['photo.jpg'] },
      { ...f.snapshot, classes: [] },
      { ...f.snapshot, images: [...f.snapshot.images, ...f.snapshot.images] },
      { ...f.snapshot, annotations: [{ ...f.snapshot.annotations[0], box: [99, 0, 2, 2] }] },
    ]) expect(snapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it.each(['lock', 'revoke'])('immediately erases data and pending proposals on %s', type => {
    const f = fixture(), { bearer } = f.pair();
    f.publish(bearer); f.bridge.propose(f.patch);
    f.bridge.browser(origin, bearer, { type });
    expect(f.bridge.status()).toMatchObject({ authorized: false, approvedDataAvailable: false });
    expect(() => f.bridge.metadata()).toThrow('denied');
    expect(() => f.bridge.browser(origin, bearer, { type: 'status' })).toThrow('denied');
  });
});

describe('revision-bound proposal queue', () => {
  it('discards rejected proposals without changing data and rejects duplicate operations or extra attributes', () => {
    const f = fixture(), { bearer } = f.pair(); f.publish(bearer);
    const proposal = f.bridge.propose(f.patch);
    f.bridge.browser(origin, bearer, { type: 'review', proposalId: proposal.proposalId,
      baseRevision: 1, outcome: 'rejected' });
    expect(f.bridge.metadata()).toEqual(f.snapshot);
    expect(f.bridge.browser(origin, bearer, { type: 'status' })).toMatchObject({ proposals: [] });
    expect(() => f.bridge.propose({ ...f.patch, operations: [...f.patch.operations, ...f.patch.operations] })).toThrow('invalid');
    expect(() => f.bridge.propose({ ...f.patch, operations: [{
      ...f.patch.operations[0], annotation: { ...f.patch.operations[0]!.annotation, gps: 'SENSITIVE' },
    }] })).toThrow('invalid');
  });

  it('never mutates data, requires existing targets, and applies only browser-reported validated transactions', () => {
    const f = fixture(), { bearer } = f.pair(); f.publish(bearer);
    const proposal = f.bridge.propose(f.patch);
    expect(f.bridge.metadata()).toEqual(f.snapshot);
    expect(() => f.bridge.propose({ ...f.patch, baseRevision: 0 })).toThrow('stale');
    expect(() => f.bridge.propose({ ...f.patch, operations: [{ ...f.patch.operations[0],
      annotation: { ...f.patch.operations[0]!.annotation, id: randomUUID() } }] })).toThrow('invalid');
    expect(() => f.bridge.propose({ ...f.patch, operations: [{ ...f.patch.operations[0],
      annotation: { ...f.patch.operations[0]!.annotation, box: [0, 0, 101, 20] } }] })).toThrow('invalid');
    expect(() => f.bridge.browser(origin, bearer, { type: 'review', proposalId: proposal.proposalId,
      baseRevision: 1, outcome: 'applied', snapshot: f.snapshot })).toThrow('stale');
    const snapshot = { ...f.snapshot, revision: 2,
      annotations: [{ ...f.snapshot.annotations[0]!, box: [5, 6, 20, 30] as [number, number, number, number] }] };
    f.bridge.browser(origin, bearer, { type: 'review', proposalId: proposal.proposalId, baseRevision: 1,
      outcome: 'applied', snapshot });
    expect(f.bridge.metadata()).toEqual(snapshot);
    expect(() => f.bridge.browser(origin, bearer, { type: 'review', proposalId: proposal.proposalId,
      baseRevision: 1, outcome: 'rejected' })).toThrow('stale');
  });

  it('invalidates old proposals on revisions and bounds queue size', () => {
    const f = fixture(), { bearer } = f.pair(); f.publish(bearer);
    const old = f.bridge.propose(f.patch);
    for (let i = 1; i < 20; i++) f.bridge.propose(f.patch);
    expect(() => f.bridge.propose(f.patch)).toThrow('limited');
    f.publish(bearer, { ...f.snapshot, revision: 2 });
    expect(() => f.bridge.browser(origin, bearer, { type: 'review', proposalId: old.proposalId,
      baseRevision: 1, outcome: 'rejected' })).toThrow('stale');
    expect(() => f.publish(bearer)).toThrow('stale');
    expect(() => f.publish(bearer, { ...f.snapshot, revision: 2, annotations: [] })).toThrow('stale');
  });

  it('keeps audit entries free of identifiers, tokens and annotation content', () => {
    const f = fixture(), { bearer, approval } = f.pair(); f.publish(bearer); f.bridge.propose(f.patch);
    const status = f.bridge.browser(origin, bearer, { type: 'status' }) as { audit: unknown[] };
    expect(status.audit).toEqual([{ event: 'paired', at: 1000 }, { event: 'proposal', at: 1000 }]);
    for (const secret of [bearer, approval.token, f.workspaceId, f.snapshot.images[0]!.id]) {
      expect(JSON.stringify(status.audit)).not.toContain(secret);
    }
  });
});
