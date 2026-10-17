import { z } from 'zod';
import { classSchema, documentSchema, skeletonSchema } from './model';
import type { AnnotationDocument } from './model';

export const datasetSchemaSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  classes: z.array(classSchema).max(10_000),
  skeletons: z.array(skeletonSchema).max(256),
}).superRefine((schema, context) => {
  for (const items of [schema.classes, schema.skeletons]) {
    if (new Set(items.map(item => item.id)).size !== items.length ||
        new Set(items.map(item => item.name)).size !== items.length) {
      context.addIssue({ code: 'custom', message: 'Workspace schema IDs and names must be unique.' });
    }
  }
});
export type DatasetSchema = z.infer<typeof datasetSchemaSchema>;
export const emptyDatasetSchema = (): DatasetSchema => ({ version: 1, revision: 0, classes: [], skeletons: [] });

export function mergeDatasetSchema(
  base: DatasetSchema,
  incoming: Pick<DatasetSchema, 'classes' | 'skeletons'>,
): DatasetSchema {
  const next = structuredClone(datasetSchemaSchema.parse(base));
  datasetSchemaSchema.parse({ version: 1, revision: 0, classes: incoming.classes, skeletons: incoming.skeletons });
  for (const item of incoming.classes) {
    const existing = next.classes.find(candidate => candidate.name === item.name);
    if (existing) {
      if (existing.exclusiveGroup !== item.exclusiveGroup) {
        throw new Error('Workspace classes have conflicting exclusive groups. Resolve the source schema before importing.');
      }
    } else {
      if (next.classes.some(candidate => candidate.id === item.id)) throw new Error('Workspace class ID has a conflicting name.');
      next.classes.push(structuredClone(item));
    }
  }
  for (const item of incoming.skeletons) {
    const existing = next.skeletons.find(candidate => candidate.name === item.name);
    if (!existing) {
      if (next.skeletons.some(candidate => candidate.id === item.id)) throw new Error('Workspace skeleton ID has a conflicting name.');
      next.skeletons.push(structuredClone(item));
      continue;
    }
    for (const name of item.points) if (!existing.points.includes(name)) existing.points.push(name);
    for (const [from, to] of item.edges) {
      const edge: [number, number] = [existing.points.indexOf(item.points[from]!), existing.points.indexOf(item.points[to]!)];
      if (!existing.edges.some(([a, b]) => a === edge[0] && b === edge[1])) existing.edges.push(edge);
    }
  }
  return datasetSchemaSchema.parse(next);
}

export function applyDatasetSchema(document: AnnotationDocument, schema: DatasetSchema): AnnotationDocument {
  const classes = new Map(schema.classes.map(item => [item.name, item]));
  const classesById = new Map(schema.classes.map(item => [item.id, item]));
  const skeletons = new Map(schema.skeletons.map(item => [item.name, item]));
  const skeletonsById = new Map(schema.skeletons.map(item => [item.id, item]));
  const localClasses = new Map(document.classes.map(item => [item.id, item]));
  const localSkeletons = new Map(document.skeletons.map(item => [item.id, item]));
  return documentSchema.parse({
    ...document,
    classes: schema.classes,
    skeletons: schema.skeletons,
    annotations: document.annotations.map(annotation => {
      const localClass = localClasses.get(annotation.classId);
      const cls = localClass && (classesById.get(localClass.id) ?? classes.get(localClass.name));
      if (!cls) throw new Error('Workspace schema is missing an annotation class.');
      if (annotation.kind !== 'keypoints') return { ...annotation, classId: cls.id };
      const local = localSkeletons.get(annotation.skeletonId);
      const skeleton = local && (skeletonsById.get(local.id) ?? skeletons.get(local.name));
      if (!local || !skeleton) throw new Error('Workspace schema is missing a keypoint skeleton.');
      const points = new Map(local.points.map((name, index) => [name, annotation.points[index]!]));
      return {
        ...annotation, classId: cls.id, skeletonId: skeleton.id,
        points: skeleton.points.map(name => points.get(name) ?? { x: 0, y: 0, visibility: 'absent' }),
      };
    }),
  });
}

export function extendDatasetSchema(previous: DatasetSchema, input: DatasetSchema): DatasetSchema {
  const next = datasetSchemaSchema.parse(input);
  if (next.revision !== previous.revision + 1) throw new Error('Workspace schema changed; reload before saving.');
  for (const item of previous.classes) {
    const replacement = next.classes.find(candidate => candidate.id === item.id);
    if (!replacement || replacement.name !== item.name || replacement.exclusiveGroup !== item.exclusiveGroup) {
      throw new Error('Workspace class removal, renaming, and exclusive-group changes need a migration and are not supported yet.');
    }
  }
  for (const item of previous.skeletons) {
    const replacement = next.skeletons.find(candidate => candidate.id === item.id);
    if (!replacement || replacement.name !== item.name ||
        item.points.some((name, index) => replacement.points[index] !== name) ||
        item.edges.some(([a, b]) => !replacement.edges.some(([x, y]) => x === a && y === b))) {
      throw new Error('Workspace skeleton removal or reordering needs a migration and is not supported yet.');
    }
  }
  return next;
}

export const classRemapsSchema = z.array(z.strictObject({ from: z.uuid(), to: z.uuid() })).max(10_000);
export type ClassRemaps = z.infer<typeof classRemapsSchema>;

export function validateDatasetMigration(previous: DatasetSchema, input: DatasetSchema, remaps: ClassRemaps): DatasetSchema {
  const next = datasetSchemaSchema.parse(input);
  classRemapsSchema.parse(remaps);
  if (next.revision !== previous.revision + 1) throw new Error('Workspace schema changed; reload before saving.');
  const removed = previous.classes.filter(item => !next.classes.some(candidate => candidate.id === item.id));
  if (new Set(remaps.map(item => item.from)).size !== remaps.length || remaps.some(item =>
    !removed.some(source => source.id === item.from) || !next.classes.some(target => target.id === item.to) ||
    !previous.classes.some(target => target.id === item.to))) {
    throw new Error('Workspace class remapping must name distinct removed classes and surviving destination classes.');
  }
  for (const item of previous.classes) {
    const replacement = next.classes.find(candidate => candidate.id === item.id);
    if (replacement && replacement.exclusiveGroup !== item.exclusiveGroup) {
      throw new Error('Workspace class exclusive-group changes are not supported by this migration.');
    }
  }
  return next;
}

export function applyDatasetMigration(
  document: AnnotationDocument, previous: DatasetSchema, next: DatasetSchema, remaps: ClassRemaps,
): { document: AnnotationDocument; discardedCoordinates: number; affectedAnnotations: number } {
  validateDatasetMigration(previous, next, remaps);
  // Legacy records and imported documents can use different IDs and point orders.
  const normalized = applyDatasetSchema(document, previous);
  const destinations = new Map(remaps.map(item => [item.from, item.to]));
  let discardedCoordinates = 0, affectedAnnotations = 0;
  const annotations = normalized.annotations.map(annotation => {
    const classId = destinations.get(annotation.classId) ?? annotation.classId;
    if (!next.classes.some(item => item.id === classId)) {
      throw new Error('Workspace class is used by annotations. Choose a surviving replacement class; annotations cannot be deleted by a schema migration.');
    }
    let affected = classId !== annotation.classId;
    if (annotation.kind === 'keypoints') {
      const before = previous.skeletons.find(item => item.id === annotation.skeletonId)!;
      const after = next.skeletons.find(item => item.id === annotation.skeletonId);
      if (!after) throw new Error('A skeleton used by keypoint annotations cannot be removed. Migrate its points or annotations first.');
      const discarded = before.points.reduce((count, name, index) => {
        const point = annotation.points[index]!;
        // Even absent points may carry meaningful imported coordinates.
        return count + Number(!after.points.includes(name) &&
          (point.visibility !== 'absent' || point.x !== 0 || point.y !== 0));
      }, 0);
      discardedCoordinates += discarded;
      affected ||= discarded > 0;
    }
    if (affected) affectedAnnotations++;
    return { ...annotation, classId };
  });
  let result: AnnotationDocument;
  try {
    result = applyDatasetSchema({ ...normalized, annotations }, next);
  } catch (failure) {
    if (failure instanceof z.ZodError) {
      const details = failure.issues.map(issue => issue.message).join(' ');
      throw new Error(`Workspace migration produced invalid annotations: ${details} Nothing was changed.`);
    }
    throw failure;
  }
  return { document: result, discardedCoordinates, affectedAnnotations };
}
