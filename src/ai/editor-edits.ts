import type { AnnotateInput } from '../../services/bridge/protocol';
import type { z } from 'zod';
import type { annotationOutput } from '../../services/bridge/protocol';
import type { DatasetSchema } from '../domain/dataset-schema';
import { isSimpleClockwisePolygon, signedArea } from '../domain/geometry';
import type { Point } from '../domain/geometry';
import type { Command } from '../domain/history';
import type { Annotation, AnnotationDocument } from '../domain/model';

export type ImageEdit = AnnotateInput['edits'][number];
export type AnnotationOutput = z.infer<typeof annotationOutput>;
export type Units = 'pixels' | 'normalized';
export interface PlannedEdit { commands: Command[]; added: string[]; updated: number; removed: number }

const palette = ['#39764d', '#b84d3b', '#416f9f', '#a56c19', '#8056a1', '#278c8a', '#9a3f74', '#5d7a1f'];
const key = (name: string) => name.trim().toLowerCase();
const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

export class EditRejected extends Error {}

/** Class names an editor request uses that the workspace does not have yet (case-insensitive). */
export function missingClasses(input: AnnotateInput, schema: DatasetSchema): string[] {
  const known = new Set(schema.classes.map(item => key(item.name)));
  const missing = new Map<string, string>();
  for (const edit of input.edits) {
    for (const item of [...(edit.add ?? []), ...(edit.update ?? [])]) {
      if (item.label && !known.has(key(item.label)) && !missing.has(key(item.label))) missing.set(key(item.label), item.label.trim());
    }
  }
  return [...missing.values()];
}

export function withClasses(schema: DatasetSchema, names: readonly string[]): DatasetSchema {
  if (!names.length) return schema;
  return {
    ...schema, revision: schema.revision + 1,
    classes: [...schema.classes, ...names.map((name, index) => ({
      id: crypto.randomUUID(), name, color: palette[(schema.classes.length + index) % palette.length]!, exclusiveGroup: null,
    }))],
  };
}

function classFor(document: AnnotationDocument, label: string) {
  const found = document.classes.find(item => key(item.name) === key(label));
  if (!found) throw new EditRejected(`Unknown class "${label}".`);
  return found.id;
}

function toBox(document: AnnotationDocument, value: readonly number[], units: Units) {
  const { width, height } = document.image.canonical;
  const sx = units === 'normalized' ? width : 1, sy = units === 'normalized' ? height : 1;
  const [x, y, w, h] = value as [number, number, number, number];
  const x0 = clamp(Math.min(x, x + w) * sx, width), y0 = clamp(Math.min(y, y + h) * sy, height);
  const x1 = clamp(Math.max(x, x + w) * sx, width), y1 = clamp(Math.max(y, y + h) * sy, height);
  if (x1 - x0 < 1 || y1 - y0 < 1) throw new EditRejected('A box is outside the image or smaller than one pixel.');
  return { x: round(x0), y: round(y0), width: round(x1 - x0), height: round(y1 - y0) };
}

function toPolygon(document: AnnotationDocument, value: readonly (readonly number[])[], units: Units): Point[] {
  const { width, height } = document.image.canonical;
  const sx = units === 'normalized' ? width : 1, sy = units === 'normalized' ? height : 1;
  let points = value.map(([x, y]) => ({ x: round(clamp(x! * sx, width)), y: round(clamp(y! * sy, height)) }));
  points = points.filter((point, index) => {
    const next = points[(index + 1) % points.length]!;
    return point.x !== next.x || point.y !== next.y;
  });
  for (let changed = true; changed && points.length >= 3;) {
    changed = false;
    for (let index = 0; index < points.length; index++) {
      const a = points[(index + points.length - 1) % points.length]!, b = points[index]!, c = points[(index + 1) % points.length]!;
      if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) === 0) { points.splice(index, 1); changed = true; break; }
    }
  }
  if (signedArea(points) < 0) points.reverse();
  if (!isSimpleClockwisePolygon(points)) throw new EditRejected('A polygon is self-intersecting, degenerate or outside the image.');
  return points;
}

/** Convert one image's editor request into ordinary, undoable domain commands. */
export function planImageEdit(document: AnnotationDocument, edit: ImageEdit, units: Units = 'pixels'): PlannedEdit {
  const commands: Command[] = [], added: string[] = [];
  const existing = new Map(document.annotations.map(item => [item.id, item]));
  const labels = new Set(document.annotations.filter(item => item.kind === 'label').map(item => item.classId));
  for (const item of edit.add ?? []) {
    const classId = classFor(document, item.label), id = crypto.randomUUID();
    let annotation: Annotation;
    if (item.box) annotation = { id, classId, attributes: {}, kind: 'box', ...toBox(document, item.box, units) };
    else if (item.polygon) annotation = { id, classId, attributes: {}, kind: 'polygon', points: toPolygon(document, item.polygon, units) };
    else {
      if (labels.has(classId)) continue;
      labels.add(classId);
      annotation = { id, classId, attributes: {}, kind: 'label' };
    }
    commands.push({ type: 'put', annotation });
    added.push(id);
  }
  let updated = 0;
  for (const item of edit.update ?? []) {
    const old = existing.get(item.id);
    if (!old) throw new EditRejected('An update refers to an annotation that no longer exists; re-read the image.');
    if (old.locked) throw new EditRejected('An update targets a locked annotation.');
    let next: Annotation = item.label ? { ...old, classId: classFor(document, item.label) } : old;
    if (item.box) {
      if (old.kind !== 'box') throw new EditRejected('Only box annotations can receive a box.');
      next = { ...next, ...toBox(document, item.box, units) } as Annotation;
    }
    if (item.polygon) {
      if (old.kind !== 'polygon') throw new EditRejected('Only polygon annotations can receive polygon points.');
      next = { ...next, points: toPolygon(document, item.polygon, units) } as Annotation;
    }
    commands.push({ type: 'put', annotation: next });
    updated++;
  }
  for (const id of edit.remove ?? []) {
    const old = existing.get(id);
    if (!old) throw new EditRejected('A removal refers to an annotation that no longer exists; re-read the image.');
    if (old.locked) throw new EditRejected('A removal targets a locked annotation.');
    commands.push({ type: 'remove', id });
  }
  if (edit.review) commands.push({ type: 'review', review: edit.review });
  else if (added.length && document.review === 'unannotated') commands.push({ type: 'review', review: 'annotated' });
  return { commands, added, updated, removed: edit.remove?.length ?? 0 };
}

/** Read-only view of a document for the editor: labels by name, geometry in original pixels, no attributes. */
export function describeAnnotations(document: AnnotationDocument): AnnotationOutput[] {
  const names = new Map(document.classes.map(item => [item.id, item.name]));
  return document.annotations.map(item => {
    const base = { id: item.id, label: names.get(item.classId) ?? 'unknown', ...(item.locked ? { locked: true as const } : {}) };
    switch (item.kind) {
      case 'box': return { ...base, kind: 'box', box: [item.x, item.y, item.width, item.height] };
      case 'polygon': return { ...base, kind: 'polygon', points: item.points.map(point => [point.x, point.y] as [number, number]) };
      case 'line': return { ...base, kind: 'line', points: item.points.map(point => [point.x, point.y] as [number, number]) };
      case 'keypoints': {
        const skeleton = document.skeletons.find(value => value.id === item.skeletonId);
        return { ...base, kind: 'keypoints', points: item.points.map((point, index) => ({
          name: skeleton?.points[index] ?? String(index), x: point.x, y: point.y, visibility: point.visibility })) };
      }
      case 'mask': return { ...base, kind: 'mask' };
      case 'label': return { ...base, kind: 'image-label' };
    }
  });
}
