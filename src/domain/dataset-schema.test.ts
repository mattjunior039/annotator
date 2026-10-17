import { describe, expect, it } from 'vitest';
import { applyDatasetMigration, applyDatasetSchema, emptyDatasetSchema, extendDatasetSchema, mergeDatasetSchema, validateDatasetMigration } from './dataset-schema';
import { documentSchema } from './model';

function document(name = 'Object', pointNames = ['Point']) {
  const classId = crypto.randomUUID(), skeletonId = crypto.randomUUID();
  return documentSchema.parse({
    version: 1, revision: 7, review: 'in_progress',
    image: {
      version: 1, id: crypto.randomUUID(), datasetId: crypto.randomUUID(), mediaId: crypto.randomUUID(),
      name: 'synthetic.png', source: { width: 30, height: 20 }, canonical: { width: 30, height: 20 }, orientation: 1,
    },
    classes: [{ id: classId, name, color: '#39764d', exclusiveGroup: null }],
    skeletons: [{ id: skeletonId, name: 'Point', points: pointNames, edges: [] }],
    annotations: [{
      id: crypto.randomUUID(), kind: 'keypoints', classId, skeletonId, attributes: {},
      points: pointNames.map((_, index) => ({ x: index + 1, y: index + 2, visibility: 'visible' })),
    }],
  });
}

describe('dataset-wide schema', () => {
  it('unifies old per-image IDs by exact name and preserves keypoint coordinates by point name', () => {
    const first = document(), second = document('Object', ['Nose', 'Point']);
    const schema = mergeDatasetSchema(mergeDatasetSchema(emptyDatasetSchema(), first), second);
    expect(schema.classes).toHaveLength(1);
    expect(schema.skeletons[0]!.points).toEqual(['Point', 'Nose']);
    const normalized = applyDatasetSchema(second, schema);
    expect(normalized.annotations[0]!.classId).toBe(first.classes[0]!.id);
    expect(normalized.annotations[0]).toMatchObject({
      skeletonId: first.skeletons[0]!.id,
      points: [{ x: 2, y: 3, visibility: 'visible' }, { x: 1, y: 2, visibility: 'visible' }],
    });
    expect(normalized.image).toEqual(second.image);
    expect(normalized.revision).toBe(7);
    expect(applyDatasetSchema(first, schema).annotations[0]).toMatchObject({
      points: [{ x: 1, y: 2, visibility: 'visible' }, { x: 0, y: 0, visibility: 'absent' }],
    });
  });
  it('keeps additive imports idempotent and does not mutate their input', () => {
    const original = document(), incoming = document('Pill');
    const base = mergeDatasetSchema(emptyDatasetSchema(), original), copy = structuredClone(base);
    const next = mergeDatasetSchema(base, incoming);
    expect(base).toEqual(copy);
    expect(next.classes.map(item => item.name)).toEqual(['Object', 'Pill']);
    expect(mergeDatasetSchema(next, incoming)).toEqual(next);
  });
  it('rejects conflicting IDs, duplicate names, missing references and exclusive groups rather than guessing', () => {
    const original = document(), schema = mergeDatasetSchema(emptyDatasetSchema(), original);
    const duplicate = document();
    duplicate.classes.push({ ...duplicate.classes[0]!, id: crypto.randomUUID() });
    expect(() => mergeDatasetSchema(schema, duplicate)).toThrow();
    const conflicting = document('Different');
    conflicting.classes[0]!.id = original.classes[0]!.id;
    expect(() => mergeDatasetSchema(schema, conflicting)).toThrow('conflicting name');
    const exclusive = document();
    exclusive.classes[0]!.exclusiveGroup = crypto.randomUUID();
    expect(() => mergeDatasetSchema(schema, exclusive)).toThrow('exclusive groups');
    expect(() => applyDatasetSchema(original, emptyDatasetSchema())).toThrow('missing');
  });
  it('accepts additions/colors and rejects stale updates and destructive schema edits', () => {
    const schema = mergeDatasetSchema(emptyDatasetSchema(), document());
    const next = structuredClone(schema);
    next.revision++;
    next.classes[0]!.color = '#ffffff';
    next.skeletons[0]!.points.push('Nose');
    expect(extendDatasetSchema(schema, next)).toEqual(next);
    expect(() => extendDatasetSchema(schema, schema)).toThrow('changed');
    const renamed = structuredClone(next);
    renamed.classes[0]!.name = 'Renamed';
    expect(() => extendDatasetSchema(schema, renamed)).toThrow('migration');
    const reordered = structuredClone(next);
    reordered.skeletons[0]!.points.reverse();
    expect(() => extendDatasetSchema(schema, reordered)).toThrow('migration');
  });
  it('migrates reordered, renamed and removed point names without shifting surviving coordinates', () => {
    const original = document('Object', ['Nose', 'Tip', 'Base']);
    original.skeletons[0]!.edges = [[0, 1], [1, 2]];
    const before = mergeDatasetSchema(emptyDatasetSchema(), original);
    const next = structuredClone(before);
    next.revision++;
    next.skeletons[0]!.points = ['Base', 'Renamed', 'Nose'];
    next.skeletons[0]!.edges = [[2, 0]];
    const copy = structuredClone(original);
    const result = applyDatasetMigration(original, before, next, []);
    expect(result).toMatchObject({ affectedAnnotations: 1, discardedCoordinates: 1 });
    expect(result.document.annotations[0]).toMatchObject({ points: [
      { x: 3, y: 4, visibility: 'visible' }, { x: 0, y: 0, visibility: 'absent' },
      { x: 1, y: 2, visibility: 'visible' },
    ] });
    expect(result.document.annotations).toHaveLength(original.annotations.length);
    expect(result.document.image).toEqual(original.image);
    expect(result.document.review).toBe(original.review);
    expect(original).toEqual(copy);
  });
  it('renames used classes and skeletons by stable ID and removes only unused skeletons', () => {
    const original = document('Object', ['Nose', 'Tip']);
    original.skeletons.push({ id: crypto.randomUUID(), name: 'Unused skeleton', points: ['Point'], edges: [] });
    const before = mergeDatasetSchema(emptyDatasetSchema(), original);
    const next = structuredClone(before);
    next.revision++;
    next.classes[0]!.name = 'Renamed class';
    next.skeletons[0]!.name = 'Renamed skeleton';
    next.skeletons.pop();
    const result = applyDatasetMigration(original, before, next, []);
    expect(result).toMatchObject({
      affectedAnnotations: 0, discardedCoordinates: 0,
      document: {
        classes: [{ name: 'Renamed class' }],
        skeletons: [{ name: 'Renamed skeleton' }],
        annotations: [{ classId: before.classes[0]!.id, skeletonId: before.skeletons[0]!.id,
          points: [{ x: 1, y: 2, visibility: 'visible' }, { x: 2, y: 3, visibility: 'visible' }] }],
      },
    });
  });
  it('rejects removing a skeleton while any annotation still references it', () => {
    const original = document();
    const before = mergeDatasetSchema(emptyDatasetSchema(), original);
    const next = { ...before, revision: before.revision + 1, skeletons: [] };
    expect(() => applyDatasetMigration(original, before, next, [])).toThrow('used by keypoint annotations');
  });
  it('normalizes legacy IDs and local point order before counting discards or remapping classes', () => {
    const canonical = document('Object', ['Tip', 'Nose']);
    const legacy = document('Object', ['Nose', 'Tip']);
    const before = mergeDatasetSchema(mergeDatasetSchema(emptyDatasetSchema(), canonical), document('Target'));
    const next = structuredClone(before);
    next.revision++;
    next.classes.shift();
    next.skeletons[0]!.points = ['Nose'];
    const result = applyDatasetMigration(legacy, before, next, [{ from: before.classes[0]!.id, to: next.classes[0]!.id }]);
    expect(result).toMatchObject({ affectedAnnotations: 1, discardedCoordinates: 1 });
    expect(result.document.annotations[0]).toMatchObject({
      classId: next.classes[0]!.id, points: [{ x: 1, y: 2, visibility: 'visible' }],
    });
  });
  it('removes unused classes but refuses to implicitly delete annotations when removing a used class', () => {
    const original = document();
    const before = mergeDatasetSchema(mergeDatasetSchema(emptyDatasetSchema(), original), document('Unused'));
    const next = { ...before, revision: before.revision + 1, classes: before.classes.slice(0, 1) };
    expect(applyDatasetMigration(original, before, next, []).document.annotations).toEqual(original.annotations);
    next.classes = before.classes.slice(1);
    expect(() => applyDatasetMigration(original, before, next, [])).toThrow('used by annotations');
    const remaps = [{ from: before.classes[0]!.id, to: next.classes[0]!.id }];
    expect(applyDatasetMigration(original, before, next, remaps)).toMatchObject({
      affectedAnnotations: 1, discardedCoordinates: 0,
      document: { annotations: [{ classId: next.classes[0]!.id }] },
    });
  });
  it('counts occupied points, including nonzero absent imports, but not empty absent placeholders', () => {
    const original = document('Object', ['Point', 'Tip', 'Base']);
    const annotation = original.annotations[0]!;
    if (annotation.kind !== 'keypoints') throw new Error('Expected keypoints');
    annotation.points[1] = { x: 0, y: 0, visibility: 'absent' };
    annotation.points[2]!.visibility = 'absent';
    const before = mergeDatasetSchema(emptyDatasetSchema(), original);
    const next = structuredClone(before);
    next.revision++; next.skeletons[0]!.points = ['Point'];
    expect(applyDatasetMigration(original, before, next, [])).toMatchObject({ affectedAnnotations: 1, discardedCoordinates: 1 });
    annotation.points[2] = { x: 0, y: 0, visibility: 'absent' };
    expect(applyDatasetMigration(original, before, next, [])).toMatchObject({ affectedAnnotations: 0, discardedCoordinates: 0 });
  });
  it('rejects stale, chained, duplicate, missing and self remaps and invalid point definitions', () => {
    const before = mergeDatasetSchema(mergeDatasetSchema(emptyDatasetSchema(), document()), document('Target'));
    const next = { ...before, revision: before.revision + 1, classes: before.classes.slice(1) };
    const from = before.classes[0]!.id, to = next.classes[0]!.id;
    expect(() => validateDatasetMigration(before, before, [])).toThrow('changed');
    for (const remaps of [[{ from, to: from }], [{ from, to: crypto.randomUUID() }],
      [{ from: to, to }], [{ from, to }, { from, to }]]) {
      expect(() => validateDatasetMigration(before, next, remaps)).toThrow('remapping');
    }
    for (const points of [[], ['Point', 'Point']]) {
      expect(() => validateDatasetMigration(before, { ...next, skeletons: [{ ...before.skeletons[0]!, points }] }, [])).toThrow();
    }
  });
  it('rejects merges that would violate label uniqueness instead of deleting labels', () => {
    const original = document(), target = document('Target');
    const before = mergeDatasetSchema(mergeDatasetSchema(emptyDatasetSchema(), original), target);
    original.classes = before.classes;
    original.annotations = before.classes.map(item => ({
      id: crypto.randomUUID(), kind: 'label' as const, classId: item.id, attributes: {},
    }));
    const next = { ...before, revision: before.revision + 1, classes: before.classes.slice(1) };
    expect(() => applyDatasetMigration(original, before, next, [{ from: before.classes[0]!.id, to: next.classes[0]!.id }]))
      .toThrow('invalid annotations');
    expect(original.annotations).toHaveLength(2);
  });
});
