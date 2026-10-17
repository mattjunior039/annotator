import { z } from 'zod';
import { isSimpleClockwisePolygon, orientedSize } from './geometry';

export const idSchema = z.uuid();
const text = z.string().trim().min(1).max(256);
const dimension = z.number().int().min(1).max(64_000_000);
export const sizeSchema = z.strictObject({ width: dimension, height: dimension })
  .refine(s => s.width * s.height <= 64_000_000, 'Image exceeds 64 megapixels.');
export const pointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const attributesSchema = z.record(z.string().min(1).max(64), z.union([
  z.string().max(4096), z.number().finite(), z.boolean(),
])).refine(a => Object.keys(a).length <= 64 && !Object.keys(a).some(
  k => ['__proto__', 'prototype', 'constructor'].includes(k)), 'Invalid attributes.');

export const classSchema = z.strictObject({
  id: idSchema, name: text, color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  exclusiveGroup: idSchema.nullable(),
});
export const skeletonSchema = z.strictObject({
  id: idSchema, name: text,
  points: z.array(text).min(1).max(256),
  edges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])).max(1024),
}).superRefine((s, ctx) => {
  if (new Set(s.points).size !== s.points.length ||
      s.edges.some(([a, b]) => a === b || a >= s.points.length || b >= s.points.length)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid skeleton names or edges.' });
  }
});
export const imageSchema = z.strictObject({
  version: z.literal(1), id: idSchema, datasetId: idSchema,
  name: text, source: sizeSchema, canonical: sizeSchema,
  orientation: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4),
    z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  mediaId: idSchema,
}).refine(i => {
  const expected = orientedSize(i.source, i.orientation);
  return expected.width === i.canonical.width && expected.height === i.canonical.height;
}, 'Canonical dimensions must match EXIF orientation.');

const common = { id: idSchema, classId: idSchema, attributes: attributesSchema,
  visible: z.boolean().optional(), locked: z.boolean().optional() };
export const annotationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common, kind: z.literal('box'), x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(), width: z.number().finite().min(1),
    height: z.number().finite().min(1),
  }),
  z.strictObject({
    ...common, kind: z.literal('polygon'),
    points: z.array(pointSchema).min(3).max(4096)
      .refine(isSimpleClockwisePolygon, 'Expected a simple clockwise polygon without collinear vertices.'),
  }),
  z.strictObject({
    ...common, kind: z.literal('mask'), width: dimension, height: dimension,
    tileSize: z.literal(256),
    tiles: z.array(z.strictObject({
      x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), blobId: idSchema,
    })).max(100_000),
  }),
  z.strictObject({
    ...common, kind: z.literal('keypoints'), skeletonId: idSchema,
    points: z.array(z.strictObject({
      x: z.number().finite(), y: z.number().finite(),
      visibility: z.enum(['absent', 'occluded', 'visible']),
    })).min(1).max(256),
  }),
  z.strictObject({ ...common, kind: z.literal('label') }),
]);

export const reviewSchema = z.enum(['unannotated', 'in_progress', 'annotated', 'reviewed']);
export const documentSchema = z.strictObject({
  version: z.literal(1), image: imageSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  classes: z.array(classSchema).max(10_000),
  skeletons: z.array(skeletonSchema).max(256),
  annotations: z.array(annotationSchema).max(100_000),
  review: reviewSchema,
}).superRefine((doc, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const classes = new Map(doc.classes.map(c => [c.id, c]));
  const skeletons = new Map(doc.skeletons.map(s => [s.id, s]));
  if (classes.size !== doc.classes.length || skeletons.size !== doc.skeletons.length ||
      new Set(doc.annotations.map(a => a.id)).size !== doc.annotations.length) issue('Duplicate IDs.');
  const { width, height } = doc.image.canonical;
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height;
  const labelClasses = new Set<string>(), exclusive = new Set<string>();
  for (const a of doc.annotations) {
    const cls = classes.get(a.classId);
    if (!cls) issue('Unknown class reference.');
    switch (a.kind) {
      case 'box':
        if (!inside(a) || !inside({ x: a.x + a.width, y: a.y + a.height })) issue('Box outside image.');
        break;
      case 'polygon':
        if (!a.points.every(inside)) issue('Polygon outside image.');
        break;
      case 'mask': {
        const tiles = new Set(a.tiles.map(t => `${t.x}:${t.y}`));
        if (a.width !== width || a.height !== height || tiles.size !== a.tiles.length ||
            a.tiles.some(t => t.x % 256 !== 0 || t.y % 256 !== 0 || t.x >= width || t.y >= height)) {
          issue('Invalid mask dimensions or tile grid.');
        }
        break;
      }
      case 'keypoints': {
        const s = skeletons.get(a.skeletonId);
        if (!s || s.points.length !== a.points.length ||
            a.points.some(p => p.visibility !== 'absent' && !inside(p))) issue('Invalid keypoints.');
        break;
      }
      case 'label':
        if (labelClasses.has(a.classId)) issue('Duplicate image label.');
        labelClasses.add(a.classId);
        if (cls?.exclusiveGroup) {
          if (exclusive.has(cls.exclusiveGroup)) issue('Mutually exclusive image labels.');
          exclusive.add(cls.exclusiveGroup);
        }
    }
  }
});

export const datasetSchema = z.strictObject({ version: z.literal(1), id: idSchema, name: text });
export const workspaceSchema = z.strictObject({
  version: z.literal(1), id: idSchema, name: text, lockedAtRest: z.boolean(),
  datasets: z.array(datasetSchema).max(10_000),
}).refine(w => new Set(w.datasets.map(d => d.id)).size === w.datasets.length, 'Duplicate dataset IDs.');

export type Annotation = z.infer<typeof annotationSchema>;
export type AnnotationDocument = z.infer<typeof documentSchema>;
export type ReviewState = z.infer<typeof reviewSchema>;
