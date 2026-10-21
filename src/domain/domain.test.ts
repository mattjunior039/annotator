import { describe, expect, it } from 'vitest';
import { imageToScreen, isSimpleClockwisePolygon, orientPoint, orientedSize, screenToImage } from './geometry';
import type { Orientation } from './geometry';
import { documentSchema, workspaceSchema } from './model';
import { ImageHistory } from './history';

const classId = crypto.randomUUID(), imageId = crypto.randomUUID();
const box = { id: crypto.randomUUID(), classId, attributes: {}, kind: 'box' as const, x: 0, y: 0, width: 10, height: 15 };
function document() {
  return documentSchema.parse({
    version: 1, image: {
      version: 1, id: imageId, datasetId: crypto.randomUUID(), name: 'synthetic.png',
      source: { width: 100, height: 80 }, canonical: { width: 100, height: 80 },
      orientation: 1, mediaId: crypto.randomUUID(),
    },
    revision: 0, classes: [{ id: classId, name: 'Object', color: '#123456', exclusiveGroup: null }],
    skeletons: [], annotations: [], review: 'unannotated',
  });
}
describe('canonical oriented-pixel geometry', () => {
  it('round trips viewport transforms across scales and offsets', () => {
    for (let i = 1; i <= 1000; i++) {
      const p = { x: i / 7, y: -i / 11 }, t = { scale: i / 101, offset: { x: -123, y: 452 } };
      const actual = screenToImage(imageToScreen(p, t), t);
      expect(actual.x).toBeCloseTo(p.x, 8); expect(actual.y).toBeCloseTo(p.y, 8);
    }
    expect(() => screenToImage({ x: 0, y: 0 }, { scale: 0, offset: { x: 0, y: 0 } })).toThrow();
  });
  it('specifies all eight EXIF edge transforms', () => {
    const expected = [[2, 3], [8, 3], [8, 17], [2, 17], [3, 2], [17, 2], [17, 8], [3, 8]];
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] satisfies Orientation[]) {
      const p = orientPoint({ x: 2, y: 3 }, { width: 10, height: 20 }, orientation);
      expect([p.x, p.y]).toEqual(expected[orientation - 1]);
      expect(orientedSize({ width: 10, height: 20 }, orientation)).toEqual(
        orientation >= 5 ? { width: 20, height: 10 } : { width: 10, height: 20 },
      );
    }
  });
  it('rejects self intersections, winding errors, collinear and repeated vertices', () => {
    expect(isSimpleClockwisePolygon([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }])).toBe(true);
    for (const points of [
      [[0, 0], [0, 5], [5, 5], [5, 0]],
      [[0, 0], [5, 5], [0, 5], [5, 0]],
      [[0, 0], [2, 0], [5, 0], [5, 5]],
      [[0, 0], [5, 0], [5, 0], [0, 5]],
    ]) expect(isSimpleClockwisePolygon(points.map(([x, y]) => ({ x: x!, y: y! })))).toBe(false);
  });
});
describe('versioned runtime schemas', () => {
  it('round trips valid documents and rejects unknown versions/fields and orientation mismatches', () => {
    const doc = document();
    expect(documentSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(documentSchema.safeParse({ ...doc, version: 2 }).success).toBe(false);
    expect(documentSchema.safeParse({ ...doc, injected: true }).success).toBe(false);
    expect(documentSchema.safeParse({ ...doc, image: { ...doc.image, orientation: 6 } }).success).toBe(false);
    expect(workspaceSchema.safeParse({ version: 2 }).success).toBe(false);
  });
  it('validates finite geometry, bounds, class references and unique instance IDs', () => {
    const doc = document();
    for (const annotation of [{ ...box, x: NaN }, { ...box, x: Infinity }, { ...box, width: 0 },
      { ...box, x: 95 }, { ...box, classId: crypto.randomUUID() }]) {
      expect(documentSchema.safeParse({ ...doc, annotations: [annotation] }).success).toBe(false);
    }
    expect(documentSchema.safeParse({ ...doc, annotations: [box, box] }).success).toBe(false);
  });
  it('validates mask tile grids and keypoint skeletons/visibility', () => {
    const doc = document(), skeletonId = crypto.randomUUID();
    const mask = { id: crypto.randomUUID(), classId, attributes: {}, kind: 'mask', width: 100, height: 80, tileSize: 256, tiles: [{ x: 0, y: 0, blobId: crypto.randomUUID() }] };
    expect(documentSchema.safeParse({ ...doc, annotations: [mask] }).success).toBe(true);
    expect(documentSchema.safeParse({ ...doc, annotations: [{ ...mask, tiles: [{ x: 1, y: 0, blobId: crypto.randomUUID() }] }] }).success).toBe(false);
    const keypoints = { id: crypto.randomUUID(), classId, attributes: {}, kind: 'keypoints', skeletonId, points: [{ x: 101, y: 0, visibility: 'visible' }] };
    const skeletons = [{ id: skeletonId, name: 'single', points: ['nose'], edges: [] }];
    expect(documentSchema.safeParse({ ...doc, skeletons, annotations: [keypoints] }).success).toBe(false);
    expect(documentSchema.safeParse({ ...doc, skeletons, annotations: [{ ...keypoints, points: [{ x: 101, y: 0, visibility: 'absent' }] }] }).success).toBe(true);
  });
  it('validates line endpoints as distinct points within the image', () => {
    const doc = document();
    const line = { id: crypto.randomUUID(), classId, attributes: {}, kind: 'line', points: [{ x: 2, y: 3 }, { x: 80, y: 70 }] };
    expect(documentSchema.safeParse({ ...doc, annotations: [line] }).success).toBe(true);
    expect(documentSchema.safeParse({ ...doc, annotations: [{ ...line, points: [{ x: 2, y: 3 }, { x: 2, y: 3 }] }] }).success).toBe(false);
    expect(documentSchema.safeParse({ ...doc, annotations: [{ ...line, points: [{ x: 101, y: 3 }, { x: 2, y: 3 }] }] }).success).toBe(false);
  });
  it('rejects duplicate and mutually exclusive image labels', () => {
    const doc = document(), group = crypto.randomUUID(), second = crypto.randomUUID();
    doc.classes = [{ ...doc.classes[0]!, exclusiveGroup: group }, { id: second, name: 'Other', color: '#ffffff', exclusiveGroup: group }];
    const label = { id: crypto.randomUUID(), classId, attributes: {}, kind: 'label' };
    expect(documentSchema.safeParse({ ...doc, annotations: [label, { ...label, id: crypto.randomUUID(), classId: second }] }).success).toBe(false);
    expect(documentSchema.safeParse({ ...doc, annotations: [label, { ...label, id: crypto.randomUUID() }] }).success).toBe(false);
  });
});
describe('revision-bound, per-image command history', () => {
  it('applies multi-command edits atomically as one revision-bound undo entry', () => {
    const history = new ImageHistory(document());
    const first = { ...box, id: crypto.randomUUID() };
    const second = { ...box, id: crypto.randomUUID(), x: 12 };
    const next = history.executeBatch([
      { type: 'put', annotation: first },
      { type: 'put', annotation: second },
      { type: 'review', review: 'reviewed' },
    ], 0);
    expect(next.revision).toBe(1);
    expect(next.annotations.map(item => item.id)).toEqual([first.id, second.id]);
    expect(next.review).toBe('reviewed');
    expect(history.undo(1)).toMatchObject({ revision: 2, annotations: [], review: 'unannotated' });
    expect(history.redo(2)).toMatchObject({ revision: 3, annotations: [first, second], review: 'reviewed' });
    expect(() => history.executeBatch([
      { type: 'put', annotation: { ...first, x: 25 } },
      { type: 'remove', id: crypto.randomUUID() },
    ], 3)).toThrow('unknown annotation');
    expect(history.snapshot()).toMatchObject({ revision: 3, annotations: [first, second], review: 'reviewed' });
  });

  it('protects locked instances without preventing explicit unlock or local undo', () => {
    const history = new ImageHistory(document());
    const locked = { ...box, locked: true };
    history.execute({ type: 'put', annotation: locked }, 0);
    expect(() => history.execute({ type: 'remove', id: box.id }, 1)).toThrow('Unlock');
    expect(() => history.execute({ type: 'put', annotation: { ...locked, x: 5 } }, 1)).toThrow('Unlock');
    history.execute({ type: 'put', annotation: { ...locked, locked: false } }, 1);
    expect(history.undo(2).annotations[0]?.locked).toBe(true);
    expect(history.undo(3).annotations).toEqual([]);
  });
  it('applies valid commands, undoes/redoes order, and invalidates redo on new edits', () => {
    const history = new ImageHistory(document()), second = { ...box, id: crypto.randomUUID() };
    history.execute({ type: 'put', annotation: box }, 0);
    history.execute({ type: 'put', annotation: second }, 1);
    history.execute({ type: 'remove', id: box.id }, 2);
    expect(history.undo(3).annotations.map(a => a.id)).toEqual([box.id, second.id]);
    expect(history.redo(4).annotations.map(a => a.id)).toEqual([second.id]);
    history.undo(5);
    history.execute({ type: 'review', review: 'reviewed' }, 6);
    expect(history.canRedo).toBe(false);
    expect(history.undo(7).review).toBe('unannotated');
  });
  it('rejects stale/invalid commands without changing history or leaking mutable state', () => {
    const history = new ImageHistory(document());
    expect(() => history.execute({ type: 'put', annotation: box }, 1)).toThrow('Stale');
    expect(() => history.execute({ type: 'put', annotation: { ...box, x: -1 } }, 0)).toThrow();
    expect(history.canUndo).toBe(false);
    const snapshot = history.execute({ type: 'put', annotation: box }, 0);
    snapshot.annotations.splice(0);
    expect(history.snapshot().annotations).toHaveLength(1);
    history.undo(1);
    expect(history.snapshot().annotations).toHaveLength(0);
    history.redo(2);
    expect(history.snapshot().annotations).toHaveLength(1);
  });
  it('bounds retained history entries', () => {
    const history = new ImageHistory(document(), 1);
    history.execute({ type: 'put', annotation: box }, 0);
    history.execute({ type: 'review', review: 'annotated' }, 1);
    history.undo(2);
    expect(history.canUndo).toBe(false);
    expect(() => history.undo(3)).toThrow('No edit');
  });
});
