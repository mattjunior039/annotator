import { describe, expect, it } from 'vitest';
import { applyDatasetSchema, emptyDatasetSchema, extendDatasetSchema, mergeDatasetSchema } from './dataset-schema';
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
});
