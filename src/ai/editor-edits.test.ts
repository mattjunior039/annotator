import { describe, expect, it } from 'vitest';
import { ImageHistory } from '../domain/history';
import { documentSchema } from '../domain/model';
import type { AnnotationDocument } from '../domain/model';
import { describeAnnotations, EditRejected, missingClasses, planImageEdit, withClasses } from './editor-edits';

function doc(): AnnotationDocument {
  const id = crypto.randomUUID(), car = crypto.randomUUID(), person = crypto.randomUUID();
  return documentSchema.parse({
    version: 1, revision: 3, review: 'unannotated', skeletons: [],
    image: { version: 1, id, datasetId: crypto.randomUUID(), name: 'secret-name.png', mediaId: crypto.randomUUID(),
      source: { width: 200, height: 100 }, canonical: { width: 200, height: 100 }, orientation: 1 },
    classes: [{ id: car, name: 'Car', color: '#39764d', exclusiveGroup: null },
      { id: person, name: 'person', color: '#b84d3b', exclusiveGroup: null }],
    annotations: [
      { id: crypto.randomUUID(), classId: car, attributes: { note: 'private' }, kind: 'box', x: 10, y: 10, width: 20, height: 20 },
      { id: crypto.randomUUID(), classId: person, attributes: {}, kind: 'box', x: 50, y: 10, width: 20, height: 20, locked: true },
    ],
  });
}
const apply = (document: AnnotationDocument, commands: ReturnType<typeof planImageEdit>['commands']) =>
  new ImageHistory(document).executeBatch(commands, document.revision);

describe('editor annotation planning', () => {
  it('adds boxes, polygons and image labels by case-insensitive class name, clamping to the image', () => {
    const document = doc();
    const plan = planImageEdit(document, { imageId: document.image.id, add: [
      { label: 'car', box: [190, 90, 50, 50] },
      { label: 'PERSON', polygon: [[0, 0], [0, 50], [50, 50], [50, 0]] },
      { label: 'Car' }, { label: 'car' },
    ] });
    const next = apply(document, plan.commands);
    expect(plan.added).toHaveLength(3);
    expect(next.annotations.at(-3)).toMatchObject({ kind: 'box', x: 190, y: 90, width: 10, height: 10 });
    expect(next.annotations.at(-2)).toMatchObject({ kind: 'polygon' });
    expect(next.annotations.at(-1)).toMatchObject({ kind: 'label', classId: document.classes[0]!.id });
    expect(next.review).toBe('annotated');
  });

  it('converts normalized coordinates and drops duplicate or collinear polygon points', () => {
    const document = doc();
    const plan = planImageEdit(document, { imageId: document.image.id, add: [
      { label: 'car', box: [0.5, 0.5, 0.25, 0.5] },
      { label: 'car', polygon: [[0, 0], [0.5, 0], [1, 0], [1, 0], [1, 1], [0, 1]] },
    ] }, 'normalized');
    const next = apply(document, plan.commands);
    expect(next.annotations.at(-2)).toMatchObject({ x: 100, y: 50, width: 50, height: 50 });
    expect(next.annotations.at(-1)).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }] });
  });

  it('updates and removes existing annotations but refuses locked, missing or mismatched targets', () => {
    const document = doc();
    const [free, locked] = document.annotations;
    const plan = planImageEdit(document, { imageId: document.image.id, update: [{ id: free!.id, label: 'person', box: [0, 0, 5, 5] }], review: 'reviewed' });
    const next = apply(document, plan.commands);
    expect(next.annotations[0]).toMatchObject({ classId: document.classes[1]!.id, x: 0, width: 5, attributes: { note: 'private' } });
    expect(next.review).toBe('reviewed');
    expect(apply(document, planImageEdit(document, { imageId: document.image.id, remove: [free!.id] }).commands).annotations).toHaveLength(1);
    for (const edit of [
      { remove: [locked!.id] }, { update: [{ id: locked!.id, box: [0, 0, 2, 2] as [number, number, number, number] }] },
      { remove: [crypto.randomUUID()] }, { update: [{ id: free!.id, polygon: [[0, 0], [1, 0], [1, 1]] as [number, number][] }] },
      { add: [{ label: 'truck', box: [0, 0, 5, 5] as [number, number, number, number] }] },
      { add: [{ label: 'car', box: [300, 300, 5, 5] as [number, number, number, number] }] },
      { add: [{ label: 'car', polygon: [[0, 0], [10, 10], [10, 0], [0, 10]] as [number, number][] }] },
    ]) expect(() => planImageEdit(document, { imageId: document.image.id, ...edit })).toThrow(EditRejected);
  });

  it('finds unknown class names once and appends them to the shared schema', () => {
    const document = doc();
    const input = { edits: [{ imageId: document.image.id, add: [{ label: 'Truck' }, { label: 'truck' }, { label: 'car' }] }] };
    const schema = { version: 1 as const, revision: 2, classes: document.classes, skeletons: [] };
    expect(missingClasses(input, schema)).toEqual(['Truck']);
    const next = withClasses(schema, ['Truck']);
    expect(next.revision).toBe(3);
    expect(next.classes.map(item => item.name)).toEqual(['Car', 'person', 'Truck']);
  });

  it('describes annotations without filenames or free-text attributes', () => {
    const output = describeAnnotations(doc());
    expect(output[0]).toEqual({ id: expect.any(String), label: 'Car', kind: 'box', box: [10, 10, 20, 20] });
    expect(output[1]).toMatchObject({ locked: true });
    const text = JSON.stringify(output);
    for (const secret of ['secret-name', 'private']) expect(text).not.toContain(secret);
  });
});
